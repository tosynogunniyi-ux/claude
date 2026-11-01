const crypto = require('crypto');
const { one, query } = require('./db');

// Platform-owner authentication. Deliberately shares nothing with src/auth.js
// except the database pool: different table, different credentials, different
// cookie, different session mechanism, different lifetime. A tenant session —
// however it was obtained, whatever role it carries — cannot be replayed here,
// because nothing in this file reads that cookie or that secret.

const COOKIE = 'profitna_admin';
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // a session dies after 12h regardless
const IDLE_MS = 2 * 60 * 60 * 1000;      // …and after 2h of doing nothing

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    // Strict, not lax: nothing outside the console should ever navigate into
    // it with the cookie attached. The console is opened directly.
    sameSite: 'strict',
    secure: Boolean(req && (req.secure || req.get('x-forwarded-proto') === 'https')),
    path: '/'
  };
}

function clientIp(req) {
  return String(req.ip || (req.connection && req.connection.remoteAddress) || '').slice(0, 64);
}

function userAgent(req) {
  return String(req.get('user-agent') || '').slice(0, 256);
}

// -------------------------------------------------------------------------
// Is there a console at all?
// -------------------------------------------------------------------------

// Until an owner account exists there is nothing to sign in to, and the whole
// surface — page and API — answers 404 rather than advertising a login form
// to anyone who guesses the path. Cached briefly so this costs nothing per
// request once the answer settles.
let consoleCache = { value: false, at: 0 };

async function consoleEnabled() {
  if (Date.now() - consoleCache.at < 30000) return consoleCache.value;
  try {
    const row = await one("SELECT 1 AS yes FROM platform_admins WHERE status = 'active' LIMIT 1");
    consoleCache = { value: Boolean(row), at: Date.now() };
  } catch {
    // Before the migration runs, the table does not exist yet.
    consoleCache = { value: false, at: Date.now() };
  }
  return consoleCache.value;
}

function forgetConsoleCache() {
  consoleCache = { value: false, at: 0 };
}

// -------------------------------------------------------------------------
// Optional network gate
// -------------------------------------------------------------------------

// ADMIN_IP_ALLOWLIST=203.0.113.4,198.51.100.0 — when set, the console does not
// exist for anyone else. Off by default, because an owner locked out by their
// own changing home IP is a worse outcome than the default.
function allowlisted(req) {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw) return true;
  const ip = clientIp(req).replace(/^::ffff:/, '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(ip);
}

// Mounted in front of both the page and the API.
async function gate(req, res, next) {
  try {
    if (!allowlisted(req)) return res.status(404).json({ error: 'Not found.' });
    if (!(await consoleEnabled())) return res.status(404).json({ error: 'Not found.' });
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) {
    next(err);
  }
}

// -------------------------------------------------------------------------
// Login throttling
// -------------------------------------------------------------------------

// Per-IP, in memory: blunt, immediate, and survives an attacker cycling
// through email addresses, which a per-account counter alone does not.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_MAX = 20;

function throttled(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(ip, { start: now, count: 0 });
    return false;
  }
  return entry.count >= PER_IP_MAX;
}

function recordAttempt(req) {
  const ip = clientIp(req);
  const entry = attempts.get(ip) || { start: Date.now(), count: 0 };
  entry.count++;
  attempts.set(ip, entry);
  if (attempts.size > 5000) attempts.clear();
}

function clearAttempts(req) {
  attempts.delete(clientIp(req));
}

// Counted in the statement rather than in JavaScript, so two attempts racing
// each other still add up to two.
async function noteFailure(admin) {
  if (!admin) return;
  await query(
    `UPDATE platform_admins
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= ${MAX_FAILURES}
                                THEN now() + interval '${LOCK_MINUTES} minutes'
                                ELSE locked_until END
      WHERE id = $1`,
    [admin.id]
  );
}

function lockedOut(admin) {
  return Boolean(admin && admin.locked_until && new Date(admin.locked_until) > new Date());
}

// -------------------------------------------------------------------------
// Sessions
// -------------------------------------------------------------------------

async function issueSession(req, res, admin) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO platform_admin_sessions (admin_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
    [admin.id, hashToken(token), clientIp(req), userAgent(req), String(ABSOLUTE_MS)]
  );
  await query(
    'UPDATE platform_admins SET last_login_at = now(), last_login_ip = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [admin.id, clientIp(req)]
  );
  res.cookie(COOKIE, token, Object.assign(cookieOptions(req), { maxAge: ABSOLUTE_MS }));
  return token;
}

async function endSession(req, res) {
  const token = req.cookies ? req.cookies[COOKIE] : null;
  if (token) {
    await query('UPDATE platform_admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      hashToken(token)
    ]);
  }
  res.clearCookie(COOKIE, cookieOptions(req));
}

async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies ? req.cookies[COOKIE] : null;
    if (!token) return res.status(401).json({ error: 'Sign in to the Control Center.' });

    const row = await one(
      `SELECT s.id AS session_id, s.last_seen_at, s.expires_at,
              a.id, a.email, a.full_name, a.status, a.totp_enrolled_at
         FROM platform_admin_sessions s
         JOIN platform_admins a ON a.id = s.admin_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [hashToken(token)]
    );

    const expired =
      !row ||
      new Date(row.expires_at) <= new Date() ||
      Date.now() - new Date(row.last_seen_at).getTime() > IDLE_MS;

    if (expired || row.status !== 'active') {
      if (row) {
        await query('UPDATE platform_admin_sessions SET revoked_at = now() WHERE id = $1', [row.session_id]);
      }
      res.clearCookie(COOKIE, cookieOptions(req));
      return res.status(401).json({ error: 'That session has ended. Sign in again.' });
    }

    await query('UPDATE platform_admin_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
    req.admin = { id: row.id, email: row.email, name: row.full_name, sessionId: row.session_id };
    next();
  } catch (err) {
    next(err);
  }
}

// -------------------------------------------------------------------------
// Audit
// -------------------------------------------------------------------------

// Every login, every failure and every change an owner makes to someone
// else's account lands here. Reads are not logged individually — the console
// is one person's, and a row per list view would bury the acts that matter.
async function adminAudit(req, action, targetType, targetId, detail) {
  await query(
    `INSERT INTO platform_audit_log (admin_id, admin_email, action, target_type, target_id, detail, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      (req.admin && req.admin.id) || null,
      (req.admin && req.admin.email) || (detail && detail.email) || null,
      action,
      targetType || null,
      targetId || null,
      detail ? JSON.stringify(detail) : null,
      clientIp(req),
      userAgent(req)
    ]
  );
}

module.exports = {
  COOKIE,
  gate,
  consoleEnabled,
  forgetConsoleCache,
  throttled,
  recordAttempt,
  clearAttempts,
  noteFailure,
  lockedOut,
  issueSession,
  endSession,
  requireAdmin,
  adminAudit,
  clientIp,
  MAX_FAILURES,
  LOCK_MINUTES
};
