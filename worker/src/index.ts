import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { connect } from 'cloudflare:sockets';
import { FRONTEND_HTML } from './frontend';

type Env = {
  DB: D1Database;
  RESUMES: R2Bucket;
  GEMINI_API_KEY: string;
  RESEND_API_KEY?: string;
};

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

// Serve frontend
app.get('/', (c) => {
  return c.html(FRONTEND_HTML);
});

app.get('/favicon.ico', (c) => {
  return c.notFound();
});

// ---- SMTP Client using cloudflare:sockets ----

class SmtpClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  private async readResponse(): Promise<string> {
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) break;
      const text = this.decoder.decode(value);
      chunks.push(text);
      if (text.includes('\r\n') && text.match(/^\d{3}\s/)) break;
      const combined = chunks.join('');
      const lines = combined.split('\r\n');
      const lastLine = lines[lines.length - 2] || lines[lines.length - 1];
      if (lastLine && lastLine.match(/^\d{3}\s/)) break;
    }
    return chunks.join('');
  }

  private async sendCommand(cmd: string): Promise<string> {
    await this.writer.write(this.encoder.encode(cmd + '\r\n'));
    return await this.readResponse();
  }

  async sendEmail(from: string, to: string, subject: string, body: string, attachments: Array<{ filename: string; content: string; content_type: string }>): Promise<string> {
    const socket = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: 'on' });

    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();

    try {
      // Read greeting
      await this.readResponse();

      // EHLO
      await this.sendCommand('EHLO localhost');

      // AUTH LOGIN
      await this.sendCommand('AUTH LOGIN');
      await this.sendCommand(btoa(from));
      const authResponse = await this.sendCommand(btoa(this._appPassword));
      if (authResponse.startsWith('5')) {
        throw new Error('SMTP auth failed: ' + authResponse);
      }

      // Build MIME message
      const mimeMessage = this.buildMimeMessage(from, to, subject, body, attachments);

      // MAIL FROM
      await this.sendCommand(`MAIL FROM:<${from}>`);

      // RCPT TO
      await this.sendCommand(`RCPT TO:<${to}>`);

      // DATA
      const dataResp = await this.sendCommand('DATA');
      if (!dataResp.startsWith('3')) {
        throw new Error('DATA command failed: ' + dataResp);
      }

      // Send message (dot-stuffing)
      const escapedMessage = mimeMessage.replace(/\r\n\./g, '\r\n..');
      await this.writer.write(this.encoder.encode(escapedMessage + '\r\n.\r\n'));
      const sendResp = await this.readResponse();
      if (sendResp.startsWith('5')) {
        throw new Error('Send failed: ' + sendResp);
      }

      // QUIT
      await this.sendCommand('QUIT');

      return sendResp;
    } finally {
      this.reader.releaseLock();
      this.writer.releaseLock();
      socket.close();
    }
  }

  private _appPassword: string = '';

  setCredentials(appPassword: string) {
    this._appPassword = appPassword;
  }

  private buildMimeMessage(
    from: string,
    to: string,
    subject: string,
    body: string,
    attachments: Array<{ filename: string; content: string; content_type: string }>
  ): string {
    const boundary = 'mixed_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const altBoundary = 'alt_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const lines: string[] = [];

    lines.push(`From: ${from}`);
    lines.push(`To: ${to}`);
    lines.push(`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`);
    lines.push('MIME-Version: 1.0');

    if (attachments.length > 0) {
      lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      lines.push('');
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push('');
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('');
      lines.push(body);
      lines.push(`--${altBoundary}--`);
      lines.push('');

      for (const att of attachments) {
        lines.push(`--${boundary}`);
        lines.push(`Content-Type: ${att.content_type}; name="${att.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        lines.push('');
        // Base64 content needs line breaks every 76 chars for MIME compliance
        const chunks = att.content.match(/.{1,76}/g) || [];
        lines.push(chunks.join('\r\n'));
        lines.push('');
      }
      lines.push(`--${boundary}--`);
    } else {
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('');
      lines.push(body);
    }

    return lines.join('\r\n');
  }
}

// ---- Auth Helpers ----

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}$${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, storedHash] = stored.split('$');
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const computedHash = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHash === storedHash;
}

async function getUser(c: any) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  const row = await c.env.DB.prepare('SELECT user_id FROM sessions WHERE token = ?').bind(token).first();
  if (!row) return null;
  return row.user_id as number;
}

async function requireAuth(c: any) {
  const userId = await getUser(c);
  if (!userId) {
    return c.json({ detail: 'Unauthorized' }, 401);
  }
  return userId;
}

// ---- Helper: Send via SMTP or Resend ----

async function sendViaSmtp(fromEmail: string, appPassword: string, toEmail: string, subject: string, body: string, attachments: Array<{ filename: string; content: string; content_type: string }>): Promise<void> {
  const client = new SmtpClient();
  client.setCredentials(appPassword);
  await client.sendEmail(fromEmail, toEmail, subject, body, attachments);
}

async function sendViaResend(apiKey: string, fromEmail: string, toEmail: string, subject: string, body: string, replyTo: string, attachments: Array<{ filename: string; content: string; content_type: string }>): Promise<void> {
  const emailPayload: any = {
    from: fromEmail,
    to: toEmail,
    subject,
    text: body,
  };
  if (replyTo) emailPayload.reply_to = replyTo;
  if (attachments.length > 0) emailPayload.attachments = attachments;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailPayload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Resend error: ${JSON.stringify(errorData)}`);
  }
}

// ---- Auth Endpoints ----

app.post('/api/auth/register', async (c) => {
  const formData = await c.req.parseBody();
  const username = formData.username as string;
  const password = formData.password as string;
  const name = formData.name as string;
  const portfolio = (formData.portfolio as string) || '';
  const linkedin = (formData.linkedin as string) || '';
  const skills = (formData.skills as string) || '';
  const resume = formData.resume as File | undefined;

  if (!username || !password || !name) {
    return c.json({ detail: 'Missing required fields' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return c.json({ detail: 'Username already exists' }, 400);
  }

  const passwordHash = await hashPassword(password);

  let resumeKey: string | null = null;
  let resumeFilename: string | null = null;

  if (resume && resume.size > 0) {
    resumeFilename = resume.name;
    const ext = resume.name.includes('.') ? '.' + resume.name.split('.').pop() : '';
    resumeKey = `${username}_resume${ext}`;
    await c.env.RESUMES.put(resumeKey, resume.stream(), {
      httpMetadata: { contentType: resume.type || 'application/pdf' },
    });
  }

  await c.env.DB.prepare(
    'INSERT INTO users (username, password_hash, name, portfolio, linkedin, skills, reply_to_email, resume_key, resume_filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(username, passwordHash, name, portfolio, linkedin, skills, '', resumeKey, resumeFilename || '').run();

  return c.json({ status: 'success' });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json();
  const { username, password } = body;

  const row = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind(username).first();
  if (!row) {
    return c.json({ detail: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPassword(password, row.password_hash as string);
  if (!valid) {
    return c.json({ detail: 'Invalid credentials' }, 401);
  }

  const token = generateToken();
  await c.env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, row.id).run();

  return c.json({ token });
});

app.get('/api/auth/me', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const row = await c.env.DB.prepare(
    'SELECT username, name, portfolio, linkedin, skills, google_email, reply_to_email, resume_key, resume_filename FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!row) {
    return c.json({ detail: 'User not found' }, 404);
  }

  return c.json({
    username: row.username,
    name: row.name || '',
    portfolio: row.portfolio || '',
    linkedin: row.linkedin || '',
    skills: row.skills || '',
    google_email: row.google_email || '',
    has_app_password: !!(row.google_email),
    reply_to_email: row.reply_to_email || '',
    has_reply_email: !!(row.reply_to_email),
    resume_filename: row.resume_filename || '',
  });
});

app.post('/api/auth/logout', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return c.json({ status: 'success' });
});

// ---- Settings ----

app.put('/api/settings', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const formData = await c.req.parseBody();
  const name = (formData.name as string) || '';
  const portfolio = (formData.portfolio as string) || '';
  const linkedin = (formData.linkedin as string) || '';
  const skills = (formData.skills as string) || '';
  const googleEmail = (formData.google_email as string) || '';
  const googleAppPassword = (formData.google_app_password as string) || '';
  const replyToEmail = (formData.reply_to_email as string) || '';
  const resume = formData.resume as File | undefined;

  const userRow = await c.env.DB.prepare('SELECT username, resume_key FROM users WHERE id = ?').bind(userId).first();
  if (!userRow) {
    return c.json({ detail: 'User not found' }, 404);
  }

  let resumeKey: string | null = userRow.resume_key as string | null;
  let resumeFilename: string | null = null;

  if (resume && resume.size > 0) {
    resumeFilename = resume.name;
    const username = userRow.username as string;
    const ext = resume.name.includes('.') ? '.' + resume.name.split('.').pop() : '';
    resumeKey = `${username}_resume${ext}`;
    await c.env.RESUMES.put(resumeKey, resume.stream(), {
      httpMetadata: { contentType: resume.type || 'application/pdf' },
    });
  }

  let query = 'UPDATE users SET name = ?, portfolio = ?, linkedin = ?, skills = ?, google_email = ?, reply_to_email = ?, resume_key = ?';
  const params: any[] = [name, portfolio, linkedin, skills, googleEmail, replyToEmail, resumeKey];

  if (googleAppPassword) {
    query += ', google_app_password = ?';
    params.push(googleAppPassword);
  }

  if (resumeFilename !== null) {
    query += ', resume_filename = ?';
    params.push(resumeFilename);
  }

  query += ' WHERE id = ?';
  params.push(userId);

  await c.env.DB.prepare(query).bind(...params).run();

  return c.json({ status: 'success' });
});

// ---- Companies ----

app.get('/api/companies', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const companies = await c.env.DB.prepare('SELECT * FROM companies ORDER BY name ASC').all();
  const apps = await c.env.DB.prepare('SELECT company_name, status FROM applications WHERE user_id = ?').bind(userId).all();

  const appStatus: Record<string, string> = {};
  for (const a of apps.results) {
    appStatus[a.company_name as string] = a.status as string;
  }

  const results = companies.results.map((row: any) => ({
    Name: row.name,
    Category: row.category,
    Address: row.address,
    Phone: row.phone,
    Email: row.email,
    Website: row.website,
    'Short Description': row.short_description,
    status: appStatus[row.name] || 'Pending',
  }));

  return c.json({ companies: results });
});

// ---- Draft ----

app.post('/api/draft', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const body = await c.req.json();
  const { company_name, category, description } = body;

  const userRow = await c.env.DB.prepare(
    'SELECT name, portfolio, linkedin, skills FROM users WHERE id = ?'
  ).bind(userId).first();

  const userName = (userRow?.name as string) || 'A passionate student';
  const portfolio = (userRow?.portfolio as string) || '';
  const linkedin = (userRow?.linkedin as string) || '';
  const skills = (userRow?.skills as string) || '';

  const prompt = `Draft a professional cold email for a marketing/digital marketing internship at a company.

My Profile:
Name: ${userName}
Skills: ${skills}
Portfolio: ${portfolio}
LinkedIn: ${linkedin}

Company Profile:
Name: ${company_name}
Category: ${category}
Description: ${description}

Requirements:
The mail should sound human and not generic.
Make it concise and politely request a marketing/digital marketing internship opportunity.
Highlight how my specific skills (${skills}) align with the company's marketing, branding, content creation, or digital growth needs, but keep it short and concise.
If the company is in a non-marketing industry, emphasize transferable skills like content strategy, social media management, brand communication, SEO/SEM, or campaign analytics.
Include my LinkedIn link naturally if provided.
Start the mail with a polite greeting and introduce myself briefly as a student passionate about marketing/digital marketing.
DONOT ASSUME ANYTHING.
DO NOT use any placeholders like [Your Name], [Company Name], [Link], etc. Fully populate the email using the exact details provided.
Return ONLY the raw email body text. Do not include a Subject line. Do not use markdown formatting wrappers (no \`\`\`) and no conversational filler.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${c.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error('Gemini API error:', JSON.stringify(data));
      return c.json({ detail: `Gemini API error: ${data.error?.message || JSON.stringify(data)}` }, 500);
    }
    const draft = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!draft) {
      console.error('Gemini returned no content:', JSON.stringify(data).substring(0, 500));
      return c.json({ detail: `Gemini returned empty response: ${JSON.stringify(data).substring(0, 200)}` }, 500);
    }
    return c.json({ draft });
  } catch (e: any) {
    console.error('Draft generation exception:', e);
    return c.json({ detail: e.message || 'Draft generation failed' }, 500);
  }
});

// ---- Refine ----

app.post('/api/refine', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const body = await c.req.json();
  const { current_draft, prompt: userPrompt } = body;

  const sysPrompt = `You are an AI assistant helping a student refine their cold email for a marketing/digital marketing internship.
Here is the current draft:
"""
${current_draft}
"""
The user wants you to modify the draft based on the following instruction:
${userPrompt}

Keep it professional, polite, and concise. Maintain focus on marketing/digital marketing skills and how they benefit the company. Return ONLY the fully revised email body text without markdown formatting wrappers or extra conversational text.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${c.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt }] }] }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error('Gemini API error (refine):', JSON.stringify(data));
      return c.json({ detail: `Gemini API error: ${data.error?.message || JSON.stringify(data)}` }, 500);
    }
    const draft = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!draft) {
      console.error('Gemini returned no content (refine):', JSON.stringify(data).substring(0, 500));
      return c.json({ detail: `Gemini returned empty response` }, 500);
    }
    return c.json({ draft });
  } catch (e: any) {
    console.error('Refine generation exception:', e);
    return c.json({ detail: e.message || 'Refine failed' }, 500);
  }
});

// ---- Ignore ----

app.post('/api/ignore', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const { company_name } = await c.req.json();
  await c.env.DB.prepare(
    'INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(company_name, '', 'Ignored', '', userId).run();

  return c.json({ status: 'success' });
});

// ---- Save Draft ----

app.post('/api/save_draft', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const { company_name, email, drafted_email } = await c.req.json();

  const existing = await c.env.DB.prepare(
    'SELECT id FROM applications WHERE company_name = ? AND user_id = ?'
  ).bind(company_name, userId).first();

  if (existing) {
    await c.env.DB.prepare(
      'UPDATE applications SET status = ?, email = ?, drafted_email = ? WHERE id = ?'
    ).bind('Drafted', email, drafted_email, existing.id).run();
  } else {
    await c.env.DB.prepare(
      'INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(company_name, email, 'Drafted', drafted_email, userId).run();
  }

  return c.json({ status: 'success' });
});

// ---- Schedule ----

app.post('/api/schedule', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const { company_names, scheduled_date } = await c.req.json();

  for (const cName of company_names) {
    await c.env.DB.prepare(
      "UPDATE applications SET status = 'Scheduled', scheduled_date = ? WHERE company_name = ? AND user_id = ? AND status = 'Drafted'"
    ).bind(scheduled_date, cName, userId).run();
  }

  return c.json({ status: 'success' });
});

// ---- Send Email ----

app.post('/api/send', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const formData = await c.req.parseBody();
  const companyName = (formData.company_name as string) || (formData.company as string) || '';
  const toEmail = (formData.to_email as string) || (formData.email as string) || '';
  const subject = (formData.subject as string) || '';
  const body = (formData.body as string) || '';
  const resumeFile = formData.resume as File | undefined;

  if (!companyName || !toEmail || !subject || !body) {
    return c.json({ detail: 'Missing required fields' }, 400);
  }

  const userRow = await c.env.DB.prepare(
    'SELECT username, name, google_email, google_app_password, reply_to_email, resume_key, resume_filename FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!userRow) {
    return c.json({ detail: 'User not found' }, 404);
  }

  // Prepare attachments
  type Attachment = { filename: string; content: string; content_type: string };
  const attachments: Attachment[] = [];

  let resumeKey = userRow.resume_key as string | null;
  let resumeFilename = (userRow.resume_filename as string) || 'resume.pdf';

  if (resumeFile && resumeFile.size > 0) {
    resumeFilename = resumeFile.name;
    const username = userRow.username as string;
    const ext = resumeFile.name.includes('.') ? '.' + resumeFile.name.split('.').pop() : '';
    resumeKey = `${username}_resume${ext}`;
    await c.env.RESUMES.put(resumeKey, resumeFile.stream(), {
      httpMetadata: { contentType: resumeFile.type || 'application/pdf' },
    });
    await c.env.DB.prepare('UPDATE users SET resume_key = ?, resume_filename = ? WHERE id = ?').bind(resumeKey, resumeFilename, userId).run();

    const arrayBuffer = await resumeFile.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    attachments.push({ filename: resumeFilename, content: base64, content_type: resumeFile.type || 'application/pdf' });
  } else if (resumeKey) {
    const r2Object = await c.env.RESUMES.get(resumeKey);
    if (r2Object) {
      const arrayBuffer = await r2Object.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      resumeFilename = r2Object.httpMetadata?.contentType || 'application/pdf';
      attachments.push({
        filename: (userRow.resume_filename as string) || 'resume.pdf',
        content: base64,
        content_type: r2Object.httpMetadata?.contentType || 'application/pdf',
      });
    }
  }

  const googleEmail = userRow.google_email as string;
  const googleAppPassword = userRow.google_app_password as string;
  const replyTo = (userRow.reply_to_email as string) || '';
  const applicantName = (userRow.name as string) || (userRow.username as string);

  try {
    if (googleEmail && googleAppPassword) {
      // Send via Gmail SMTP (App Password)
      await sendViaSmtp(googleEmail, googleAppPassword, toEmail, subject, body, attachments);
      // Also set reply-to by adding it to the body header if needed
    } else if (c.env.RESEND_API_KEY) {
      // Fallback: Send via Resend API
      const resendFrom = `Marketing InternTracker <onboarding@resend.dev>`;
      await sendViaResend(c.env.RESEND_API_KEY, resendFrom, toEmail, subject, body, replyTo, attachments);
    } else {
      return c.json({ detail: 'No email credentials configured. Add a Gmail App Password in Settings.' }, 400);
    }
  } catch (e: any) {
    return c.json({ detail: `Email sending failed: ${e.message}` }, 500);
  }

  // Update application status
  const existing = await c.env.DB.prepare(
    'SELECT id FROM applications WHERE company_name = ? AND user_id = ?'
  ).bind(companyName, userId).first();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE applications SET status = 'Sent', email = ?, drafted_email = ?, sent_date = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(toEmail, body, existing.id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO applications (company_name, email, status, drafted_email, user_id) VALUES (?, ?, 'Sent', ?, ?)"
    ).bind(companyName, toEmail, body, userId).run();
  }

  return c.json({ status: 'success' });
});

// ---- Applications ----

app.get('/api/applications', async (c) => {
  const userId = await requireAuth(c);
  if (typeof userId !== 'number') return userId;

  const results = await c.env.DB.prepare(
    'SELECT id, company_name, email, status, sent_date, drafted_email, scheduled_date FROM applications WHERE user_id = ?'
  ).bind(userId).all();

  const applications = results.results.map((row: any) => ({
    id: row.id,
    company: row.company_name,
    email: row.email,
    status: row.status,
    date: row.sent_date,
    drafted_email: row.drafted_email,
    scheduled_date: row.scheduled_date,
  }));

  return c.json({ applications });
});

// ---- Scheduled Email Handler (Cron) ----

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = new Date().toISOString();

    const results = await env.DB.prepare(
      `SELECT a.id, a.company_name, a.email, a.drafted_email, a.user_id, u.name, u.username, u.google_email, u.google_app_password, u.reply_to_email, u.resume_key, u.resume_filename
       FROM applications a JOIN users u ON a.user_id = u.id
       WHERE a.status = 'Scheduled' AND a.scheduled_date <= ?`
    ).bind(now).all();

    for (const row of results.results as any[]) {
      if (!row.email) continue;
      if (!row.google_email || !row.google_app_password) continue;

      const applicantName = row.name || row.username;
      const subject = `Marketing Internship Application (May-June 2026) - ${applicantName}`;
      const attachments: Array<{ filename: string; content: string; content_type: string }> = [];

      if (row.resume_key) {
        try {
          const r2Object = await env.RESUMES.get(row.resume_key);
          if (r2Object) {
            const arrayBuffer = await r2Object.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            attachments.push({
              filename: row.resume_filename || 'resume.pdf',
              content: base64,
              content_type: r2Object.httpMetadata?.contentType || 'application/pdf',
            });
          }
        } catch (e) {
          console.error('Failed to fetch resume:', e);
        }
      }

      try {
        await sendViaSmtp(row.google_email, row.google_app_password, row.email, subject, row.drafted_email || '', attachments);
        await env.DB.prepare("UPDATE applications SET status = 'Sent', sent_date = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id).run();
      } catch (e) {
        console.error('Failed to send scheduled email:', e);
      }
    }
  },
};