# Marketing Internship Tracker - Cloudflare Workers Deployment

Free-tier hosting using Cloudflare Workers + D1 + R2 + Pages.

## Architecture

| Component | Service | Free Tier |
|-----------|---------|-----------|
| API Backend | Cloudflare Workers | 100K req/day |
| Database | Cloudflare D1 | 5M reads/day, 100K writes/day, 5GB |
| Resume Storage | Cloudflare R2 | 10GB, 1M writes/month |
| Email Sending | Gmail SMTP (via App Password) | Your Gmail account |
| Fallback Email | Resend API (optional) | 100 emails/day |
| AI (Drafts) | Google Gemini API | Own API key |
| Frontend | Cloudflare Pages | Unlimited static requests |
| Scheduled Emails | Cron Triggers | 5 crons/account |

## Email Sending

**Primary: Gmail SMTP via App Password** - Emails are sent directly from your personal Gmail using an App Password. The app connects to `smtp.gmail.com:465` via TLS using Cloudflare Workers' TCP socket API. No third-party email service required.

To set up:
1. Go to your [Google Account Security page](https://myaccount.google.com/security)
2. Enable **2-Step Verification** (required for App Passwords)
3. Search for **App Passwords** and create one for "Mail"
4. Enter your Gmail address and the 16-character App Password in the app's Settings page

**Fallback: Resend API** - If no Gmail credentials are configured, the app falls back to Resend (100 emails/day free tier). Set `RESEND_API_KEY` as a Wrangler secret to enable this.

## Prerequisites

1. **Cloudflare account** (free) - [signup](https://dash.cloudflare.com/sign-up)
2. **Node.js 18+** and **npm**
3. **Google Gemini API key** - [get one](https://aistudio.google.com/apikey)
4. **Gmail account** with App Password (for email sending)

## Step-by-Step Deployment

### 1. Install Wrangler CLI and dependencies

```bash
cd worker
npm install
npm install -g wrangler
wrangler login
```

### 2. Create D1 database

```bash
wrangler d1 create intern-tracker-db
```

Copy the `database_id` from the output and paste it into `worker/wrangler.toml` (replace `REPLACE_WITH_YOUR_DATABASE_ID`).

### 3. Create R2 bucket

```bash
wrangler r2 bucket create intern-tracker-resumes
```

### 4. Run schema migration

```bash
# Local (for development)
npm run db:migrate

# Remote (production)
npm run db:migrate:remote
```

### 5. Seed company data

```bash
# Local
npm run db:seed

# Remote (production)
npm run db:seed:remote
```

### 6. Set secrets

```bash
wrangler secret put GEMINI_API_KEY
# Paste your Gemini API key

# Optional: set Resend API key as email fallback
wrangler secret put RESEND_API_KEY
# Paste your Resend API key (re_xxxxx) - only needed if not using Gmail SMTP
```

### 7. Deploy the Worker

```bash
npm run deploy
```

Note the deployed URL (e.g., `https://intern-tracker.your-subdomain.workers.dev`).

### 8. Deploy the Frontend on Cloudflare Pages

1. Go to [Cloudflare Dashboard -> Pages](https://dash.cloudflare.com/?to=/:account/pages)
2. Click **Create a project** -> **Direct Upload**
3. Upload the `frontend/` directory
4. Set the **Build output directory** to `/` (root)
5. Under **Environment variables**, add:
   - `API_BASE_URL` = your Worker URL (e.g., `https://intern-tracker.your-subdomain.workers.dev`)

**Alternative:** For same-domain setup (recommended), add a custom domain to both the Worker and Pages project and configure the frontend to use relative URLs (which is the default).

### 9. Use the app

1. Open the frontend URL
2. Sign up with your details
3. Go to Settings and enter your **Gmail address** and **16-digit App Password**
4. Upload your resume
5. Start drafting and sending emails!

## Local Development

```bash
cd worker
npm install
npm run dev
```

The Worker runs at `http://127.0.0.1:8787` by default. The frontend can connect to it by setting:

```javascript
// In browser console or localStorage
localStorage.setItem('API_BASE_URL', 'http://127.0.0.1:8787');
```

Then serve the frontend with any static file server:

```bash
cd frontend
npx serve .
```

## API Endpoints

All endpoints are prefixed with `/api/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user (multipart form) |
| POST | `/api/auth/login` | Login, returns session token |
| GET | `/api/auth/me` | Get current user info |
| POST | `/api/auth/logout` | Logout (delete session) |
| PUT | `/api/settings` | Update profile/settings (multipart form) |
| GET | `/api/companies` | List all companies with application status |
| POST | `/api/draft` | Generate AI draft email |
| POST | `/api/refine` | Refine draft with AI |
| POST | `/api/ignore` | Mark company as ignored |
| POST | `/api/save_draft` | Save a draft |
| POST | `/api/schedule` | Schedule drafts for sending |
| POST | `/api/send` | Send email immediately |
| GET | `/api/applications` | List all user applications |

## Cost Estimate (Free Tier)

| Resource | Free Allowance | This App's Usage |
|----------|---------------|------------------|
| Workers | 100K req/day | ~100-500/day |
| D1 | 5M reads/day | ~1K-5K/day |
| R2 | 10GB + 1M writes/month | <1GB |
| Gmail SMTP | ~500 emails/day | ~10-50/day |
| Resend (fallback) | 100 emails/day | unused if Gmail configured |
| Cron | 5 triggers | 1 (every minute) |
| Pages | Unlimited | Static HTML |

**Total monthly cost: $0** for typical internship tracking usage.

## Migrating from Docker Setup

If you were previously running the Docker version:

1. Export your users and application data from SQLite
2. Import into D1 using `wrangler d1 execute`
3. Upload resume files to R2 using `wrangler r2 object put`
4. Update the frontend API_BASE_URL to point to the Worker

## Troubleshooting

- **"Company not found" errors**: Make sure you ran the seed SQL (`npm run db:seed:remote`)
- **Email sending fails with Gmail**: Verify your App Password is correct (16 chars, no spaces). Make sure 2-Step Verification is enabled on your Google account.
- **Gmail "Less secure app" error**: Google requires App Passwords now (not regular passwords). Create one at myaccount.google.com > Security > App Passwords.
- **AI draft generation fails**: Verify your Gemini API key is set as a Wrangler secret
- **CORS errors**: The Worker has CORS enabled for all origins, but make sure the frontend API_BASE_URL is correct
- **Scheduled emails not sending**: Check Wrangler logs with `wrangler tail` and verify the cron trigger is set up correctly