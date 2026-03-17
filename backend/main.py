import os
import sqlite3
import pandas as pd
import hashlib
import secrets
import asyncio
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Body, File, UploadFile, Form, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel
import smtplib
from email.message import EmailMessage

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://0.0.0.0:3000",
        "*"
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_FILE = "applications.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS applications
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  company_name TEXT,
                  email TEXT,
                  status TEXT,
                  drafted_email TEXT,
                  user_id INTEGER,
                  sent_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    try:
        c.execute("ALTER TABLE applications ADD COLUMN user_id INTEGER DEFAULT 1")
    except:
        pass
        
    try:
        c.execute("ALTER TABLE applications ADD COLUMN scheduled_date TEXT")
    except:
        pass
        
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  username TEXT UNIQUE,
                  password_hash TEXT,
                  google_email TEXT,
                  google_app_password TEXT,
                  name TEXT,
                  github TEXT,
                  linkedin TEXT,
                  skills TEXT,
                  resume_path TEXT,
                  resume_filename TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions
                 (token TEXT PRIMARY KEY,
                  user_id INTEGER)''')
    conn.commit()
    conn.close()

init_db()

# Load Data
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
df = pd.read_csv(os.path.join(DATA_DIR, 'infopark_companies_categorized.csv'))

# Setup Gemini
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

# ---- Auth Utils ----
def hash_pwd(password: str):
    salt = secrets.token_hex(8)
    return salt + "$" + hashlib.sha256((password + salt).encode('utf-8')).hexdigest()

def verify_pwd(password: str, hashed: str):
    salt, _hash = hashed.split("$")
    return hashlib.sha256((password + salt).encode('utf-8')).hexdigest() == _hash

def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ")[1]
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT user_id FROM sessions WHERE token = ?", (token,))
    row = c.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid token")
    return row[0]


class AuthRequest(BaseModel):
    username: str
    password: str

@app.post("/api/auth/register")
def register(
    username: str = Form(...),
    password: str = Form(...),
    name: str = Form(...),
    github: str = Form(""),
    linkedin: str = Form(""),
    skills: str = Form(""),
    resume: UploadFile = File(...)
):
    import shutil
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    # Check if username exists
    c.execute("SELECT id FROM users WHERE username = ?", (username,))
    if c.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Save the resume
    os.makedirs("uploads", exist_ok=True)
    file_extension = os.path.splitext(resume.filename)[1]
    safe_resume_path = f"uploads/{username}_resume{file_extension}"
    with open(safe_resume_path, "wb") as buffer:
        shutil.copyfileobj(resume.file, buffer)
        
    try:
        c.execute("""
            INSERT INTO users 
            (username, password_hash, name, github, linkedin, skills, resume_path, resume_filename) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (username, hash_pwd(password), name, github, linkedin, skills, safe_resume_path, resume.filename))
        conn.commit()
        return {"status": "success"}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.post("/api/auth/login")
def login(req: AuthRequest):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, password_hash FROM users WHERE username = ?", (req.username,))
    row = c.fetchone()
    if not row or not verify_pwd(req.password, row[1]):
        conn.close()
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    token = secrets.token_hex(32)
    c.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, row[0]))
    conn.commit()
    conn.close()
    return {"token": token}

@app.get("/api/auth/me")
def get_me(user_id: int = Depends(get_current_user)):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT username, google_email, google_app_password, name FROM users WHERE id = ?", (user_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "username": row[0],
        "google_email": row[1] or "",
        "has_app_password": bool(row[2]),
        "name": row[3] or ""
    }

class SettingsRequest(BaseModel):
    google_email: str
    google_app_password: str

@app.post("/api/settings")
def update_settings(req: SettingsRequest, user_id: int = Depends(get_current_user)):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("UPDATE users SET google_email = ?, google_app_password = ? WHERE id = ?", 
              (req.google_email, req.google_app_password, user_id))
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.post("/api/auth/logout")
def logout(authorization: str = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    return {"status": "success"}

# ---- End Auth Endpoints ----

class EmailDraftRequest(BaseModel):
    company_name: str
    category: str
    description: str

@app.get("/api/companies")
def get_companies(user_id: int = Depends(get_current_user)):
    records = df.fillna("").to_dict(orient="records")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT company_name, status FROM applications WHERE user_id = ?", (user_id,))
    app_status = {row[0]: row[1] for row in c.fetchall()}
    conn.close()
    
    for r in records:
        r['status'] = app_status.get(r['Name'], 'Pending')
        
    return {"companies": records}

@app.post("/api/draft")
def draft_email(req: EmailDraftRequest, user_id: int = Depends(get_current_user)):
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT name, github, linkedin, skills FROM users WHERE id = ?", (user_id,))
        user_data = c.fetchone()
        conn.close()
        
        user_name = user_data[0] if user_data and user_data[0] else "A passionate student"
        github = user_data[1] if user_data and user_data[1] else ""
        linkedin = user_data[2] if user_data and user_data[2] else ""
        skills = user_data[3] if user_data and user_data[3] else ""

        prompt = f"""
        Draft a professional cold email for an internship at a company.
        
        My Profile:
        Name: {user_name}
        Skills: {skills}
        GitHub: {github}
        LinkedIn: {linkedin}

        Company Profile:
        Name: {req.company_name}
        Category: {req.category}
        Description: {req.description}
        
        Requirements:
        The mail should sound human and not generic.
        Make it concise and politely request an internship opportunity.
        Highlight how my specific skills ({skills}) align with the company profile, but keep it short and concise.
        Include my GitHub and LinkedIn links naturally if provided.
        Start the mail with a polite greeting and introduce myself(2nd Year B.Tech Student).
        DONOT ASSUME ANYTHING.
        DO NOT use any placeholders like [Your Name], [Company Name], [Link], etc. Fully populate the email using the exact details provided.
        Return ONLY the raw email body text. Do not include a Subject line. Do not use markdown formatting wrappers (no ```) and no conversational filler.
        """
        response = client.models.generate_content(
            model='gemma-3-27b-it',
            contents=prompt
        )
        return {"draft": response.text.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class EditDraftRequest(BaseModel):
    current_draft: str
    prompt: str

@app.post("/api/refine")
def refine_draft(req: EditDraftRequest, user_id: int = Depends(get_current_user)):
    try:
        sys_prompt = f"""
        You are an AI assistant helping a student refine their cold email for an internship.
        Here is the current draft:
        \"\"\"
        {req.current_draft}
        \"\"\"
        The user wants you to modify the draft based on the following instruction:
        {req.prompt}
        
        Keep it professional, polite, and concise. Return ONLY the fully revised email body text without markdown formatting wrappers or extra conversational text.
        """
        response = client.models.generate_content(
            model='gemma-3-27b-it',
            contents=sys_prompt
        )
        return {"draft": response.text.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class IgnoreCompanyRequest(BaseModel):
    company_name: str

@app.post("/api/ignore")
def ignore_company(req: IgnoreCompanyRequest, user_id: int = Depends(get_current_user)):
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, 'Ignored', ?, ?)",
                  (req.company_name, "", "", user_id))
        conn.commit()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SaveDraftRequest(BaseModel):
    company_name: str
    email: str
    drafted_email: str

@app.post("/api/save_draft")
def save_draft(req: SaveDraftRequest, user_id: int = Depends(get_current_user)):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id FROM applications WHERE company_name = ? AND user_id = ?", (req.company_name, user_id))
    row = c.fetchone()
    if row:
        c.execute("UPDATE applications SET status='Drafted', email=?, drafted_email=? WHERE id=?", (req.email, req.drafted_email, row[0]))
    else:
        c.execute("INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, 'Drafted', ?, ?)", (req.company_name, req.email, req.drafted_email, user_id))
    conn.commit()
    conn.close()
    return {"status": "success"}

class ScheduleRequest(BaseModel):
    company_names: list[str]
    scheduled_date: str

@app.post("/api/schedule")
def schedule_drafts(req: ScheduleRequest, user_id: int = Depends(get_current_user)):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    for c_name in req.company_names:
        c.execute("UPDATE applications SET status='Scheduled', scheduled_date=? WHERE company_name=? AND user_id=? AND status='Drafted'", (req.scheduled_date, c_name, user_id))
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.post("/api/send")
def send_email(
    company_name: str = Form(...),
    to_email: str = Form(...),
    subject: str = Form(...),
    body: str = Form(...),
    user_id: int = Depends(get_current_user)
):
    try:
        # Fetch user's stored Google credentials and resume details
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT google_email, google_app_password, resume_path, resume_filename FROM users WHERE id = ?", (user_id,))
        row = c.fetchone()
        if not row or not row[0] or not row[1]:
            conn.close()
            raise HTTPException(status_code=400, detail="Google credentials not configured in settings.")
        google_email, google_app_password, resume_path, resume_filename = row[0], row[1], row[2], row[3]
        
        msg = EmailMessage()
        msg.set_content(body)
        msg['Subject'] = subject
        msg['From'] = google_email
        msg['To'] = to_email

        if resume_path and os.path.exists(resume_path):
            with open(resume_path, "rb") as f:
                resume_data = f.read()
            msg.add_attachment(
                resume_data,
                maintype='application',
                subtype='octet-stream',
                filename=resume_filename or "resume.pdf"
            )

        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        server.login(google_email, google_app_password)
        server.send_message(msg)
        server.quit()

        c.execute("SELECT id FROM applications WHERE company_name = ? AND user_id = ?", (company_name, user_id))
        row_exists = c.fetchone()
        if row_exists:
            c.execute("UPDATE applications SET status='Sent', email=?, drafted_email=?, sent_date=CURRENT_TIMESTAMP WHERE id=?", (to_email, body, row_exists[0]))
        else:
            c.execute("INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, 'Sent', ?, ?)",
                      (company_name, to_email, body, user_id))
        conn.commit()
        conn.close()

        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/applications")
def get_applications(user_id: int = Depends(get_current_user)):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, company_name, email, status, sent_date, drafted_email, scheduled_date FROM applications WHERE user_id = ?", (user_id,))
    rows = c.fetchall()
    conn.close()
    return {"applications": [{"id": r[0], "company": r[1], "email": r[2], "status": r[3], "date": r[4], "drafted_email": r[5], "scheduled_date": r[6]} for r in rows]}

async def mail_scheduler_loop():
    while True:
        await asyncio.sleep(15)  # check every 15s
        try:
            now_iso = datetime.now(timezone.utc).isoformat()
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute('''
                SELECT a.id, a.company_name, a.email, a.drafted_email, a.user_id, u.google_email, u.google_app_password, u.resume_path, u.resume_filename, u.name, u.username
                FROM applications a JOIN users u ON a.user_id = u.id 
                WHERE a.status = 'Scheduled' AND a.scheduled_date <= ?
            ''', (now_iso,))
            rows = c.fetchall()
            for row in rows:
                app_id, c_name, to_email, body, u_id, g_email, g_pwd, r_path, r_name, u_name, u_username = row
                if to_email and g_email and g_pwd:
                    msg = EmailMessage()
                    msg.set_content(body)
                    applicant_name = u_name or u_username
                    msg['Subject'] = f"Software Engineering Internship Application (May-June 2026) - {applicant_name}"
                    msg['From'] = g_email
                    msg['To'] = to_email

                    if r_path and os.path.exists(r_path):
                        with open(r_path, "rb") as f:
                            r_data = f.read()
                        msg.add_attachment(r_data, maintype='application', subtype='octet-stream', filename=r_name or "resume.pdf")

                    server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
                    server.login(g_email, g_pwd)
                    server.send_message(msg)
                    server.quit()
                    
                    c.execute("UPDATE applications SET status='Sent', sent_date=CURRENT_TIMESTAMP WHERE id=?", (app_id,))
                    conn.commit()
                    
                    await asyncio.sleep(2)  # delay 2s per mail
            conn.close()
        except Exception as e:
            print("Scheduler Error:", e)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(mail_scheduler_loop())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
