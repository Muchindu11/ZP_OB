/**
 * ============================================================
 *  ZAMBIA POLICE SERVICE — Occurrence Book Backend
 *  Secure REST API | Node.js + Express + SQLite + JWT
 * ============================================================
 */

'use strict';

const express      = require('express');
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const cors         = require('cors');
const { body, param, query, validationResult } = require('express-validator');
const path         = require('path');
const crypto       = require('crypto');

// ── Environment ───────────────────────────────────────────────────────────────
const PORT           = process.env.PORT         || 3000;
const JWT_SECRET     = process.env.JWT_SECRET;       // MUST be set in .env
const JWT_EXPIRY     = process.env.JWT_EXPIRY    || '8h';   // one shift
const FRONTEND_ORIGIN= process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set. Set it in your .env file.');
  process.exit(1);
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

// ── Database Setup ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'zp_ob.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS officers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT    NOT NULL,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK(role IN ('Officer','Administrator')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','utc')),
    created_by    INTEGER REFERENCES officers(id)
  );

  CREATE TABLE IF NOT EXISTS ob_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_number  TEXT    UNIQUE NOT NULL,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    offence     TEXT    NOT NULL,
    details     TEXT    NOT NULL,
    officer_id  INTEGER NOT NULL REFERENCES officers(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','utc'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    action       TEXT    NOT NULL,
    entry_ref    TEXT,
    officer_id   INTEGER REFERENCES officers(id),
    reason       TEXT,
    ip_address   TEXT,
    user_agent   TEXT,
    timestamp    TEXT    NOT NULL DEFAULT (datetime('now','utc'))
  );
`);

// Seed default admin if the table is empty
const { count } = db.prepare('SELECT COUNT(*) AS count FROM officers').get();
if (count === 0) {
  const hash = bcrypt.hashSync('ZP@Admin2025!', 12);
  db.prepare(`
    INSERT INTO officers (full_name, username, password_hash, role)
    VALUES (?, ?, ?, ?)
  `).run('System Administrator', 'admin', hash, 'Administrator');
  console.log('──────────────────────────────────────────────');
  console.log('  DEFAULT ADMIN SEEDED');
  console.log('  Username : admin');
  console.log('  Password : ZP@Admin2025!');
  console.log('  CHANGE THIS PASSWORD IMMEDIATELY ON FIRST LOGIN');
  console.log('──────────────────────────────────────────────');
}

// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'"],
      styleSrc   : ["'self'", "'unsafe-inline'"],
      imgSrc     : ["'self'", "data:"],
      connectSrc : ["'self'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy  : true,
}));

app.use(cors({
  origin     : FRONTEND_ORIGIN,
  credentials: true,
  methods    : ['GET','POST','PATCH','DELETE'],
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,  // 15 minutes
  max      : 5,
  message  : { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders  : false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max     : 120,
  message : { error: 'Rate limit exceeded.' },
});

app.use('/api/', apiLimiter);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function audit(action, officerId, ip, userAgent, entryRef = null, reason = null) {
  db.prepare(`
    INSERT INTO audit_log (action, entry_ref, officer_id, reason, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(action, entryRef, officerId, reason, ip, userAgent);
}

function generateRef() {
  const year = new Date().getFullYear();
  const last = db.prepare(`
    SELECT ref_number FROM ob_entries
    WHERE ref_number LIKE ? ORDER BY id DESC LIMIT 1
  `).get(`OB/${year}/%`);
  const seq = last ? parseInt(last.ref_number.split('/')[2], 10) + 1 : 1;
  return `OB/${year}/${String(seq).padStart(4, '0')}`;
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    error  : 'Validation failed.',
    details: errors.array().map(e => ({ field: e.path, msg: e.msg }))
  });
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    req.officer = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Session expired. Please log in again.'
      : 'Invalid session token.';
    return res.status(401).json({ error: msg });
  }
}

function requireAdmin(req, res, next) {
  if (req.officer?.role !== 'Administrator') {
    audit(
      'UNAUTHORIZED_ADMIN_ATTEMPT',
      req.officer?.id,
      getClientIp(req),
      req.headers['user-agent']
    );
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

// ── Routes: Authentication ────────────────────────────────────────────────────
app.post('/api/auth/login',
  loginLimiter,
  body('username').trim().isLength({ min: 1, max: 50 }),
  body('password').isLength({ min: 1, max: 128 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid credentials.' });

    const { username, password } = req.body;
    const ip        = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';

    const officer = db.prepare(`
      SELECT * FROM officers WHERE username = ? AND is_active = 1
    `).get(username);

    // Always hash-compare to prevent timing attacks (even if user not found)
    const DUMMY_HASH = '$2a$12$invalidhashstringtopreventtimingattackXXXXXXXXXXXXXXX';
    const hashToCompare = officer ? officer.password_hash : DUMMY_HASH;
    const valid = bcrypt.compareSync(password, hashToCompare);

    if (!officer || !valid) {
      audit(`FAILED_LOGIN:${username}`, null, ip, userAgent);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = jwt.sign(
      { id: officer.id, username: officer.username, role: officer.role, name: officer.full_name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    audit('LOGIN', officer.id, ip, userAgent);
    res.json({
      token,
      officer: {
        name    : officer.full_name,
        username: officer.username,
        role    : officer.role,
      }
    });
  }
);

app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit('LOGOUT', req.officer.id, getClientIp(req), req.headers['user-agent']);
  res.json({ message: 'Logged out successfully.' });
});

app.post('/api/auth/change-password',
  requireAuth,
  body('current_password').isLength({ min: 1, max: 128 }),
  body('new_password').isLength({ min: 8, max: 128 })
    .matches(/[A-Z]/).withMessage('Must contain an uppercase letter.')
    .matches(/[0-9]/).withMessage('Must contain a number.')
    .matches(/[^A-Za-z0-9]/).withMessage('Must contain a special character.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { current_password, new_password } = req.body;
    const officer = db.prepare('SELECT * FROM officers WHERE id = ?').get(req.officer.id);
    if (!bcrypt.compareSync(current_password, officer.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = bcrypt.hashSync(new_password, 12);
    db.prepare('UPDATE officers SET password_hash = ? WHERE id = ?').run(newHash, officer.id);
    audit('PASSWORD_CHANGED', officer.id, getClientIp(req), req.headers['user-agent']);
    res.json({ message: 'Password changed successfully.' });
  }
);

// ── Routes: OB Entries ────────────────────────────────────────────────────────
const ALLOWED_CATEGORIES = ['Assault','Theft','Traffic','Domestic','Fraud','Other'];

app.get('/api/entries',
  requireAuth,
  query('category').optional().isIn(ALLOWED_CATEGORIES),
  query('date').optional().isDate(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { category, date, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT e.id, e.ref_number, e.date, e.time, e.category,
             e.offence, e.details, e.created_at,
             o.full_name AS officer_name
      FROM ob_entries e
      JOIN officers o ON e.officer_id = o.id
      WHERE 1=1
    `;
    const params = [];
    if (category) { sql += ' AND e.category = ?'; params.push(category); }
    if (date)     { sql += ' AND e.date = ?';     params.push(date); }

    const countSql = sql.replace(
      /SELECT[\s\S]+?FROM/,
      'SELECT COUNT(*) AS count FROM'
    ).split('JOIN')[0] + ` JOIN officers o ON e.officer_id = o.id WHERE 1=1`
    + (category ? ` AND e.category = '${category}'` : '')
    + (date     ? ` AND e.date = '${date}'` : '');

    sql += ' ORDER BY e.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const entries = db.prepare(sql).all(...params);
    const total   = db.prepare(`
      SELECT COUNT(*) AS count FROM ob_entries
      ${category || date ? 'WHERE' : ''}
      ${category ? `category = '${category}'` : ''}
      ${category && date ? ' AND ' : ''}
      ${date ? `date = '${date}'` : ''}
    `).get().count;

    res.json({ entries, total, limit, offset });
  }
);

app.post('/api/entries',
  requireAuth,
  body('date').isDate().withMessage('Valid date required (YYYY-MM-DD).'),
  body('time').matches(/^\d{2}:\d{2}$/).withMessage('Valid time required (HH:MM).'),
  body('category').isIn(ALLOWED_CATEGORIES).withMessage('Invalid category.'),
  body('offence').trim().isLength({ min: 2, max: 200 }).escape(),
  body('details').trim().isLength({ min: 5, max: 3000 }).escape(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { date, time, category, offence, details } = req.body;
    const ref = generateRef();

    db.prepare(`
      INSERT INTO ob_entries (ref_number, date, time, category, offence, details, officer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ref, date, time, category, offence, details, req.officer.id);

    audit('ENTRY_CREATED', req.officer.id, getClientIp(req), req.headers['user-agent'], ref);
    res.status(201).json({ ref_number: ref, message: 'Entry recorded successfully.' });
  }
);

app.get('/api/entries/:ref',
  requireAuth,
  param('ref').matches(/^OB\/\d{4}\/\d{4}$/),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid reference format.' });

    const entry = db.prepare(`
      SELECT e.*, o.full_name AS officer_name
      FROM ob_entries e JOIN officers o ON e.officer_id = o.id
      WHERE e.ref_number = ?
    `).get(req.params.ref);

    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    res.json(entry);
  }
);

app.delete('/api/entries/:ref',
  requireAuth, requireAdmin,
  param('ref').matches(/^OB\/\d{4}\/\d{4}$/),
  body('reason').trim().isLength({ min: 10, max: 500 })
    .withMessage('Deletion reason required (min 10 characters).'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const entry = db.prepare('SELECT * FROM ob_entries WHERE ref_number = ?').get(req.params.ref);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });

    db.prepare('DELETE FROM ob_entries WHERE ref_number = ?').run(req.params.ref);
    audit(
      'ENTRY_DELETED',
      req.officer.id,
      getClientIp(req),
      req.headers['user-agent'],
      req.params.ref,
      req.body.reason
    );

    res.json({ message: `Entry ${req.params.ref} permanently deleted. Audit log updated.` });
  }
);

// ── Routes: Officers ──────────────────────────────────────────────────────────
app.get('/api/officers', requireAuth, requireAdmin, (req, res) => {
  const officers = db.prepare(`
    SELECT id, full_name, username, role, is_active, created_at,
           (SELECT COUNT(*) FROM ob_entries WHERE officer_id = officers.id) AS entry_count
    FROM officers
    ORDER BY full_name ASC
  `).all();
  res.json(officers);
});

app.post('/api/officers',
  requireAuth, requireAdmin,
  body('full_name').trim().isLength({ min: 2, max: 100 }).escape(),
  body('username').trim().isLength({ min: 3, max: 50 }).isAlphanumeric()
    .withMessage('Username must be alphanumeric (3–50 chars).'),
  body('password').isLength({ min: 8, max: 128 })
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter.')
    .matches(/[0-9]/).withMessage('Password must contain a number.')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain a special character.'),
  body('role').isIn(['Officer','Administrator']),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { full_name, username, password, role } = req.body;
    const existing = db.prepare('SELECT id FROM officers WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already exists.' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO officers (full_name, username, password_hash, role, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(full_name, username, hash, role, req.officer.id);

    audit(`OFFICER_CREATED:${username}`, req.officer.id, getClientIp(req), req.headers['user-agent']);
    res.status(201).json({ id: result.lastInsertRowid, message: `Officer ${username} created.` });
  }
);

app.patch('/api/officers/:id/deactivate',
  requireAuth, requireAdmin,
  param('id').isInt({ min: 1 }).toInt(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid officer ID.' });

    if (req.params.id === req.officer.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }

    const officer = db.prepare('SELECT * FROM officers WHERE id = ?').get(req.params.id);
    if (!officer) return res.status(404).json({ error: 'Officer not found.' });

    db.prepare('UPDATE officers SET is_active = 0 WHERE id = ?').run(req.params.id);
    audit(`OFFICER_DEACTIVATED:${officer.username}`, req.officer.id, getClientIp(req), req.headers['user-agent']);
    res.json({ message: `Officer ${officer.username} deactivated.` });
  }
);

// ── Routes: Audit Log ─────────────────────────────────────────────────────────
app.get('/api/audit',
  requireAuth, requireAdmin,
  query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  (req, res) => {
    const limit = req.query.limit || 200;
    const log = db.prepare(`
      SELECT a.id, a.action, a.entry_ref, a.reason, a.ip_address, a.timestamp,
             o.username AS officer_username, o.full_name AS officer_name
      FROM audit_log a
      LEFT JOIN officers o ON a.officer_id = o.id
      ORDER BY a.id DESC
      LIMIT ?
    `).all(limit);
    res.json(log);
  }
);

// ── Routes: Stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    total   : db.prepare('SELECT COUNT(*) AS n FROM ob_entries').get().n,
    today   : db.prepare('SELECT COUNT(*) AS n FROM ob_entries WHERE date = ?').get(today).n,
    officers: db.prepare('SELECT COUNT(*) AS n FROM officers WHERE is_active = 1').get().n,
    byCategory: db.prepare(`
      SELECT category, COUNT(*) AS count FROM ob_entries GROUP BY category
    `).all(),
  };
  res.json(stats);
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ ZP OB Server running on port ${PORT}`);
  console.log(`  Environment   : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Allowed origin: ${FRONTEND_ORIGIN}\n`);
});

module.exports = app;
