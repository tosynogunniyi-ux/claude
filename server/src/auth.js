const jwt = require('jsonwebtoken');
const { one } = require('./db');

const COOKIE = 'profitna_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set — refusing to sign or verify sessions');
  return s;
}

// Marked secure whenever the request actually arrived over HTTPS, rather than
// relying on NODE_ENV being set correctly. Behind a reverse proxy the TLS ends
// at the proxy, so this reads the forwarded protocol — app.set('trust proxy')
// makes req.secure honour it. A deployment that forgets NODE_ENV still gets a
// cookie that only travels over HTTPS.
function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req && (req.secure || req.get('x-forwarded-proto') === 'https'))
  };
}

function issue(req, res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, secret(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, Object.assign(cookieOptions(req), { maxAge: MAX_AGE_MS }));
  return token;
}

function clear(req, res) {
  res.clearCookie(COOKIE, cookieOptions(req));
}

function readToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return req.cookies ? req.cookies[COOKIE] : null;
}

// Said to the account holder, so it explains rather than accuses, and points
// somewhere they can actually go.
const SUSPENDED_MESSAGE = {
  suspended: 'This account is suspended. Contact support@profitna.com to restore access.',
  deactivated: 'This account has been closed. Contact support@profitna.com if that is unexpected.'
};

// Populates req.user. 401s rather than falling through, so no handler can
// accidentally run unauthenticated.
async function requireAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    const payload = jwt.verify(token, secret());
    const user = await one(
      'SELECT id, email, full_name, auth_provider, status FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    // Checked on every request, not only at sign-in: suspending an account in
    // the Control Center has to end the sessions it already has open, and the
    // session token itself is self-contained and cannot be revoked.
    if (user.status !== 'active') {
      clear(req, res);
      return res.status(403).json({ error: SUSPENDED_MESSAGE[user.status] || SUSPENDED_MESSAGE.suspended });
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session expired. Sign in again.' });
  }
}

const RANK = { viewer: 0, accountant: 1, admin: 2 };

// Resolves :orgId against the caller's memberships. Every data route mounts
// this, so an organization the caller does not belong to is a 404 — the only
// place tenant scoping is decided.
function requireOrg(minRole) {
  return async (req, res, next) => {
    const orgId = req.params.orgId;
    if (!/^[0-9a-f-]{36}$/i.test(orgId || '')) {
      return res.status(404).json({ error: 'No such organisation.' });
    }
    const membership = await one(
      `SELECT m.role, o.id, o.book_type
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2`,
      [req.user.id, orgId]
    );
    if (!membership) return res.status(404).json({ error: 'No such organisation.' });
    if (minRole && RANK[membership.role] < RANK[minRole]) {
      return res.status(403).json({ error: 'Your role does not allow that.' });
    }
    req.orgId = orgId;
    req.role = membership.role;
    req.bookType = membership.book_type;
    next();
  };
}

// Written on every successful sign-in. "Last login and account activity" is
// one of the things the Control Center exists to show, and nothing else in
// the product was recording it.
async function recordLogin(req, userId) {
  const { query } = require('./db');
  await query(
    `UPDATE users
        SET last_login_at = now(), last_login_ip = $2, login_count = login_count + 1
      WHERE id = $1`,
    [userId, String(req.ip || '').slice(0, 64)]
  );
}

async function audit(orgId, userId, action, entityType, entityId, detail) {
  const { query } = require('./db');
  await query(
    `INSERT INTO audit_log (organization_id, user_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, userId, action, entityType, entityId || null, detail ? JSON.stringify(detail) : null]
  );
}

module.exports = { issue, clear, requireAuth, requireOrg, audit, recordLogin, SUSPENDED_MESSAGE, COOKIE };
