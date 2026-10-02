const crypto = require('crypto');
const { one, many, query } = require('./db');

// Who is on a set of books, and how a second person gets there.
//
// A seat is a thing the subscriber pays for, so the two counts that matter —
// people already on the books, and invitations still outstanding — are always
// added together before another is allowed. Otherwise an organisation could
// invite twenty-five people onto a one-seat plan and let them all in.

const ROLES = ['admin', 'accountant', 'viewer'];

const ROLE_NOTE = {
  admin: 'Full access — books, settings, team and billing.',
  accountant: 'Enter and edit transactions, invoices, bills and reports.',
  viewer: 'Read-only access to the dashboard and reports.'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// What the subscriber copies and sends. Built from the request so it is right
// behind a proxy, on a custom domain, and in development alike.
function inviteLink(req, token) {
  const base =
    process.env.PUBLIC_URL ||
    (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  return base.replace(/\/+$/, '') + '/?invite=' + token;
}

function normaliseRole(value, fallback) {
  const role = String(value || '').toLowerCase();
  return ROLES.includes(role) ? role : fallback;
}

// -------------------------------------------------------------------------
// Seats
// -------------------------------------------------------------------------

async function seatUse(organizationId, client) {
  const run = client ? (sql, p) => client.query(sql, p).then((r) => r.rows[0]) : one;
  const row = await run(
    `SELECT
       (SELECT COUNT(*)::int FROM memberships WHERE organization_id = $1) AS members,
       (SELECT COUNT(*)::int FROM invitations
         WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > now()) AS pending,
       (SELECT seats FROM subscriptions WHERE organization_id = $1) AS seats`,
    [organizationId]
  );
  const seats = row.seats || 1;
  return { members: row.members, pending: row.pending, seats, used: row.members + row.pending, free: seats - (row.members + row.pending) };
}

function seatMessage(use) {
  return (
    'All ' + use.seats + (use.seats === 1 ? ' seat is' : ' seats are') + ' taken — ' +
    use.members + (use.members === 1 ? ' person' : ' people') +
    (use.pending ? ' and ' + use.pending + ' invitation' + (use.pending === 1 ? '' : 's') : '') +
    '. Add a seat under Subscription first.'
  );
}

// -------------------------------------------------------------------------
// Invitations
// -------------------------------------------------------------------------

// Issues an invitation, or reissues the link for one already outstanding. The
// raw token is returned to the caller and never stored, so this is the only
// moment the link exists anywhere but in the subscriber's hands.
async function invite({ organizationId, email, name, role, invitedBy }, client) {
  const run = client ? (sql, p) => client.query(sql, p) : query;
  const address = String(email || '').trim().toLowerCase();

  if (!EMAIL_RE.test(address)) return { error: 'Enter a valid email address for each person you are inviting.' };

  const already = await (client
    ? client.query(
        `SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND lower(u.email) = $2`,
        [organizationId, address]
      ).then((r) => r.rows[0])
    : one(
        `SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND lower(u.email) = $2`,
        [organizationId, address]
      ));
  if (already) return { error: address + ' is already on these books.' };

  const token = newToken();
  // Reissuing rather than duplicating: the partial unique index makes a second
  // pending invitation for the same address impossible, so this updates it and
  // the old link stops working.
  const row = (await run(
    `INSERT INTO invitations (organization_id, email, full_name, role, token_hash, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   role = EXCLUDED.role,
                   token_hash = EXCLUDED.token_hash,
                   invited_by = EXCLUDED.invited_by,
                   created_at = now(),
                   expires_at = now() + interval '14 days'
     RETURNING id, email, full_name, role, created_at, expires_at`,
    [organizationId, address, String(name || '').trim() || null, normaliseRole(role, 'viewer'), hashToken(token), invitedBy || null]
  )).rows[0];

  return { invitation: row, token };
}

function findByToken(token) {
  return one(
    `SELECT i.*, o.name AS org_name, o.book_type,
            u.full_name AS invited_by_name
       FROM invitations i
       JOIN organizations o ON o.id = i.organization_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hashToken(String(token || ''))]
  );
}

function invitationState(row) {
  if (!row) return 'unknown';
  if (row.revoked_at) return 'cancelled';
  if (row.accepted_at) return 'accepted';
  if (new Date(row.expires_at) <= new Date()) return 'expired';
  return 'pending';
}

async function members(organizationId) {
  return many(
    `SELECT u.id, u.full_name AS name, u.email, u.status, u.last_login_at AS "lastLoginAt",
            m.role, m.created_at AS "joinedAt"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1
      ORDER BY m.created_at`,
    [organizationId]
  );
}

async function pendingInvitations(organizationId) {
  return many(
    `SELECT id, email, full_name AS name, role, created_at AS "createdAt", expires_at AS "expiresAt"
       FROM invitations
      WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at`,
    [organizationId]
  );
}

// An organisation with nobody who can change anything is a support ticket
// waiting to happen, so the last admin cannot be demoted or removed.
async function otherAdmins(organizationId, exceptUserId) {
  const row = await one(
    `SELECT COUNT(*)::int AS n FROM memberships
      WHERE organization_id = $1 AND role = 'admin' AND user_id <> $2`,
    [organizationId, exceptUserId]
  );
  return row.n;
}

module.exports = {
  ROLES,
  ROLE_NOTE,
  EMAIL_RE,
  hashToken,
  newToken,
  inviteLink,
  normaliseRole,
  seatUse,
  seatMessage,
  invite,
  findByToken,
  invitationState,
  members,
  pendingInvitations,
  otherAdmins
};
