# ZP OB — Secure Backend Architecture & Setup Guide

**Zambia Police Service · Occurrence Book System**
*Security Upgrade Documentation*

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        OFFICER'S BROWSER                        │
│                                                                 │
│   index.html + api.js                                           │
│   ┌───────────────────────────────────────────────────────┐    │
│   │  sessionStorage (token only — cleared on tab close)   │    │
│   │  All data fetched from API — nothing stored locally   │    │
│   └───────────────────────┬───────────────────────────────┘    │
└───────────────────────────┼─────────────────────────────────────┘
                            │ HTTPS  Bearer JWT
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        NODE.JS SERVER                           │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   helmet.js  │  │  rate-limit  │  │   express-validator  │  │
│  │  (CSP/HSTS)  │  │  (5 tries/   │  │   (input sanitise)   │  │
│  │              │  │   15 min)    │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  JWT Auth Middleware  →  Role Check  →  Route Handler    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            │                                    │
│                            ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   SQLite (zp_ob.db)                      │  │
│  │                                                          │  │
│  │   officers     ob_entries     audit_log                  │  │
│  │   (bcrypt      (server-side   (write-only from          │  │
│  │    hashed)      ref numbers)   client perspective)       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Vulnerabilities Fixed

| # | Vulnerability | Before | After |
|---|---------------|--------|-------|
| 1 | Auth bypass | `localStorage` editable in DevTools | JWT signed server-side; client cannot forge |
| 2 | Plaintext passwords | Stored in `localStorage` | bcrypt hashed (cost 12) in SQLite |
| 3 | No server-side auth | All checks in JS the user controls | All checks in Express middleware |
| 4 | XSS (stored) | `innerHTML` with user data | `textContent` + `escape()` on all inputs |
| 5 | Audit log tampering | `localStorage.removeItem()` | Audit log in SQLite, no DELETE API exposed |
| 6 | No rate limiting | Unlimited login attempts | 5 attempts per 15 minutes per IP |
| 7 | No CSP | None | `helmet` enforces strict CSP |
| 8 | Session never expires | Lives until `localStorage.clear()` | JWT expires in 8h + 30 min inactivity timer |
| 9 | Timing attack on login | Early return if user not found | Always runs `bcrypt.compareSync` regardless |
| 10 | No input validation | Any string accepted | `express-validator` on every field, server-side |

---

## Prerequisites

- Node.js 18 or later (`node --version`)
- npm (`npm --version`)
- A Linux server or local machine (Ubuntu / Debian / Kali)

---

## Installation

### 1. Copy the project files

```bash
mkdir zp_ob_backend && cd zp_ob_backend
# Copy server.js, package.json, .env.example, and the public/ folder here
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your .env file

```bash
cp .env.example .env
nano .env
```

Generate a strong JWT secret:

```bash
node -e "const c=require('crypto');console.log(c.randomBytes(64).toString('hex'))"
```

Paste the output as the value of `JWT_SECRET` in `.env`.

### 4. Place your frontend

Copy your `index.html` and all assets (logo, CSS) into the `public/` folder.
Add this line inside the `<head>` of `index.html`:

```html
<script src="/api.js"></script>
```

### 5. Start the server

```bash
# Development (auto-restarts on file change)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3000`.

### 6. First login

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `ZP@Admin2025!` |

**Change this password immediately** via the change-password function.

---

## Integrating api.js into your index.html

### Login form

Replace your existing login handler:

```javascript
// BEFORE (insecure — reading from localStorage)
function handleLogin() {
  const officers = JSON.parse(localStorage.getItem('zp_officers'));
  const match = officers.find(o => o.username === user && o.password === pass);
  if (match) { localStorage.setItem('zp_session', JSON.stringify(match)); }
}

// AFTER (secure — server validates credentials, returns signed JWT)
async function handleLogin() {
  try {
    const result = await ZPAPI.login(usernameInput.value, passwordInput.value);
    if (result) showDashboard(result.officer);
  } catch (err) {
    showError(err.message); // e.g. "Invalid username or password."
  }
}
```

### Load OB entries

```javascript
// BEFORE
const entries = JSON.parse(localStorage.getItem('zp_entries')) || [];
renderEntries(entries);

// AFTER
async function loadEntries() {
  const { entries, total } = await ZPAPI.getEntries({ limit: 50 });
  renderEntries(entries);
  updateTotal(total);
}
```

### Render entries safely (XSS patch)

```javascript
// BEFORE (XSS vulnerable — user data inserted into innerHTML)
tableBody.innerHTML += `<tr><td>${entry.offence}</td><td>${entry.details}</td></tr>`;

// AFTER (safe — textContent only)
function renderEntries(entries) {
  tableBody.innerHTML = '';
  entries.forEach(entry => {
    const row = ZPAPI.buildEntryRow(entry);
    tableBody.appendChild(row);
  });
}
```

### Create entry

```javascript
// AFTER
async function submitEntry() {
  try {
    const result = await ZPAPI.createEntry({
      date    : dateInput.value,
      time    : timeInput.value,
      category: categorySelect.value,
      offence : offenceInput.value,
      details : detailsTextarea.value,
    });
    showSuccess(`Entry recorded: ${result.ref_number}`);
    loadEntries();
  } catch (err) {
    showError(err.message);
  }
}
```

### Check role (for UI show/hide)

```javascript
// AFTER — role comes from the server-issued JWT, not from localStorage
const officer = ZPAPI.getOfficer();
if (officer?.role === 'Administrator') {
  adminPanel.style.display = 'block';
}
```

---

## Running in Production (Ubuntu VPS)

### Use PM2 to keep the server alive

```bash
npm install -g pm2
pm2 start server.js --name zp-ob
pm2 save
pm2 startup    # auto-start on reboot
```

### Enable HTTPS with Nginx + Let's Encrypt

```bash
sudo apt install nginx certbot python3-certbot-nginx -y

# Create Nginx config at /etc/nginx/sites-available/zp-ob:
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass       http://localhost:3000;
        proxy_set_header Host             $host;
        proxy_set_header X-Forwarded-For  $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/zp-ob /etc/nginx/sites-enabled/
sudo certbot --nginx -d yourdomain.com
sudo systemctl reload nginx
```

### Backup the database daily

```bash
crontab -e
# Add:
0 2 * * * cp /path/to/zp_ob.db /path/to/backups/zp_ob_$(date +\%F).db
```

---

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/logout` | Officer | Logout (audit logged) |
| POST | `/api/auth/change-password` | Officer | Change own password |
| GET | `/api/entries` | Officer | List entries (filter by date/category) |
| POST | `/api/entries` | Officer | Create new OB entry |
| GET | `/api/entries/:ref` | Officer | Get single entry |
| DELETE | `/api/entries/:ref` | Admin | Delete entry (reason required) |
| GET | `/api/officers` | Admin | List all officers |
| POST | `/api/officers` | Admin | Create officer account |
| PATCH | `/api/officers/:id/deactivate` | Admin | Deactivate account |
| GET | `/api/stats` | Officer | Dashboard counts |
| GET | `/api/audit` | Admin | Audit log (last 200) |

---

## Security Checklist (go through before going live)

- [ ] `JWT_SECRET` is set to a random 64+ character string
- [ ] `.env` file is NOT committed to GitHub (add `.env` to `.gitignore`)
- [ ] Default `admin` password has been changed
- [ ] HTTPS is enabled on the server
- [ ] `FRONTEND_ORIGIN` in `.env` is set to your actual domain
- [ ] Database file (`zp_ob.db`) is not publicly accessible
- [ ] Automated daily backups are configured
- [ ] PM2 is running and configured to restart on reboot
- [ ] Server firewall allows only ports 80, 443, and 22 (SSH)

---

*Document prepared for Zambia Police Service CID Financial, Cyber & IP Unit — Copperbelt*
