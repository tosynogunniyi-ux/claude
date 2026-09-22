const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const totp = require('../totp');
const pricing = require('../pricing');
const billing = require('../billing');
const paystack = require('../integrations/paystack');
const {
  requireAdmin,
  adminAudit,
  issueSession,
  endSession,
  throttled,
  recordAttempt,
  clearAttempts,
  noteFailure,
  lockedOut,
  MAX_FAILURES,
  LOCK_MINUTES
} = require('../admin-auth');

const router = express.Router();

// A hash of a value nobody holds. Compared against when the email does not
// exist, so a missing account costs the same time as a wrong password and the
// response cannot be used to enumerate owner accounts.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);

// 'expired' is derived, never stored: the same rule invoices follow here. A
// stored expiry is only correct until the next midnight nothing ran through.
const PERIOD_END = `COALESCE(s.current_period_end, s.trial_start + ${pricing.TRIAL_DAYS})`;
const EFFECTIVE_STATUS = `CASE
    WHEN s.id IS NULL THEN 'none'
    WHEN s.status = 'cancelled' THEN 'cancelled'
    WHEN s.status = 'suspended' THEN 'suspended'
    WHEN ${PERIOD_END} < CURRENT_DATE THEN 'expired'
    WHEN s.status = 'trialing' THEN 'trial'
    ELSE s.status
  END`;

const USER_STATUSES = ['active', 'suspended', 'deactivated'];
const SUB_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'suspended'];
const SUB_FILTERS = ['trial', 'active', 'past_due', 'expired', 'cancelled', 'suspended', 'none'];

function bad(res, message) {
  return res.status(400).json({ error: message });
}

function page(req) {
  const size = Math.min(200, Math.max(5, parseInt(req.query.pageSize, 10) || 25));
  const number = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { size, number, offset: (number - 1) * size };
}

// =========================================================================
// SIGN IN
// =========================================================================

router.post('/login', async (req, res, next) => {
  try {
    if (throttled(req)) {
      return res.status(429).json({ error: 'Too many attempts from this network. Try again in 15 minutes.' });
    }
    recordAttempt(req);

    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const code = String(body.code || '');

    const admin = await one(
      `SELECT id, email, full_name, password_hash, totp_secret, totp_enrolled_at, status,
              failed_attempts, locked_until
         FROM platform_admins WHERE email = $1`,
      [email]
    );

    if (lockedOut(admin)) {
      await adminAudit(req, 'admin.login.locked', 'platform_admin', admin.id, { email });
      return res.status(423).json({
        error: 'This account is locked after ' + MAX_FAILURES + ' failed attempts. Try again in ' + LOCK_MINUTES + ' minutes.'
      });
    }

    const usable = admin && admin.status === 'active';
    const passwordOk = await bcrypt.compare(password, usable ? admin.password_hash : DUMMY_HASH);

    // Second factor is required unless this deployment has explicitly turned
    // it off, or the account predates having a secret.
    const wantsCode = process.env.ADMIN_TOTP !== 'off' && usable && Boolean(admin.totp_secret);
    const codeOk = !wantsCode || totp.verify(admin.totp_secret, code);

    if (!usable || !passwordOk || !codeOk) {
      if (usable) await noteFailure(admin);
      await adminAudit(req, 'admin.login.failed', 'platform_admin', admin ? admin.id : null, {
        email,
        reason: !usable ? 'no account' : !passwordOk ? 'password' : 'code'
      });
      // One message for every kind of failure: which half was wrong is not
      // information an attacker gets for free.
      return res.status(401).json({ error: 'Those details do not match a Control Center account.' });
    }

    // First successful sign-in with the secret the CLI printed completes
    // enrolment; from here the code is not optional.
    if (wantsCode && !admin.totp_enrolled_at) {
      await query('UPDATE platform_admins SET totp_enrolled_at = now() WHERE id = $1', [admin.id]);
    }

    clearAttempts(req);
    await issueSession(req, res, admin);
    req.admin = { id: admin.id, email: admin.email, name: admin.full_name };
    await adminAudit(req, 'admin.login', 'platform_admin', admin.id, null);

    res.json({ admin: { email: admin.email, name: admin.full_name } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await endSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Everything past this point requires a live Control Center session.
router.use(requireAdmin);

router.get('/me', async (req, res, next) => {
  try {
    const admin = await one(
      'SELECT email, full_name AS name, last_login_at, totp_enrolled_at FROM platform_admins WHERE id = $1',
      [req.admin.id]
    );
    res.json({ admin, totpRequired: process.env.ADMIN_TOTP !== 'off' });
  } catch (err) {
    next(err);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const current = String((req.body || {}).current || '');
    const next_ = String((req.body || {}).next || '');
    if (next_.length < 12) return bad(res, 'Choose a password of at least 12 characters.');

    const admin = await one('SELECT password_hash FROM platform_admins WHERE id = $1', [req.admin.id]);
    if (!(await bcrypt.compare(current, admin.password_hash))) {
      return res.status(401).json({ error: 'That is not your current password.' });
    }

    await query('UPDATE platform_admins SET password_hash = $2 WHERE id = $1', [
      req.admin.id,
      await bcrypt.hash(next_, 12)
    ]);
    // Every other session this account has open stops working immediately: a
    // password change is how you respond to one being stolen.
    await query(
      'UPDATE platform_admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [req.admin.id, req.admin.sessionId]
    );
    await adminAudit(req, 'admin.password.changed', 'platform_admin', req.admin.id, null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await many(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at,
              (id = $2) AS current
         FROM platform_admin_sessions
        WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC`,
      [req.admin.id, req.admin.sessionId]
    );
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/revoke-others', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      'UPDATE platform_admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [req.admin.id, req.admin.sessionId]
    );
    await adminAudit(req, 'admin.sessions.revoked', 'platform_admin', req.admin.id, { count: rowCount });
    res.json({ revoked: rowCount });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// OVERVIEW
// =========================================================================

router.get('/overview', async (req, res, next) => {
  try {
    const [users, subs, live, money, signupTrend, revenueTrend, expiring, recentUsers, recentPayments] =
      await Promise.all([
        one(`SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'active')::int      AS active,
                    COUNT(*) FILTER (WHERE status = 'suspended')::int   AS suspended,
                    COUNT(*) FILTER (WHERE status = 'deactivated')::int AS deactivated,
                    COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int  AS new7,
                    COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new30,
                    COUNT(*) FILTER (WHERE last_login_at >= now() - interval '30 days')::int AS seen30
               FROM users`),

        one(`WITH e AS (SELECT ${EFFECTIVE_STATUS} AS eff, ${PERIOD_END} AS period_end FROM subscriptions s)
             SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE eff = 'active')::int    AS active,
                    COUNT(*) FILTER (WHERE eff = 'trial')::int     AS trial,
                    COUNT(*) FILTER (WHERE eff = 'expired')::int   AS expired,
                    COUNT(*) FILTER (WHERE eff = 'cancelled')::int AS cancelled,
                    COUNT(*) FILTER (WHERE eff = 'suspended')::int AS suspended,
                    COUNT(*) FILTER (WHERE eff = 'past_due')::int  AS past_due,
                    COUNT(*) FILTER (WHERE eff IN ('active', 'trial')
                                       AND period_end BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS expiring
               FROM e`),

        many(`SELECT s.cycle, s.seats FROM subscriptions s WHERE ${EFFECTIVE_STATUS} = 'active'`),

        one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0) AS total,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'success'
                             AND created_at >= now() - interval '30 days'), 0) AS last30,
                    COUNT(*) FILTER (WHERE status = 'failed'
                             AND created_at >= now() - interval '30 days')::int AS failed30
               FROM payments`),

        many(`SELECT d::date AS day, COUNT(u.id)::int AS count
                FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, interval '1 day') d
                LEFT JOIN users u ON u.created_at::date = d::date
               GROUP BY d ORDER BY d`),

        many(`SELECT to_char(m, 'YYYY-MM') AS month, COALESCE(SUM(p.amount), 0) AS amount
                FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '11 months',
                                     date_trunc('month', CURRENT_DATE), interval '1 month') m
                LEFT JOIN payments p ON date_trunc('month', p.created_at) = m AND p.status = 'success'
               GROUP BY m ORDER BY m`),

        many(`SELECT o.id AS "orgId", o.name AS "orgName", s.cycle, s.seats,
                     ${PERIOD_END} AS "periodEnd", ${EFFECTIVE_STATUS} AS status,
                     (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
                       WHERE m.organization_id = o.id ORDER BY m.created_at LIMIT 1) AS email
                FROM subscriptions s
                JOIN organizations o ON o.id = s.organization_id
               WHERE ${EFFECTIVE_STATUS} IN ('active', 'trial')
                 AND ${PERIOD_END} BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
               ORDER BY ${PERIOD_END} LIMIT 12`),

        many(`SELECT u.id, u.full_name AS name, u.email, u.created_at AS "createdAt",
                     o.name AS "orgName", o.book_type AS book
                FROM users u
                LEFT JOIN LATERAL (SELECT m.organization_id FROM memberships m
                                    WHERE m.user_id = u.id ORDER BY m.created_at LIMIT 1) m ON true
                LEFT JOIN organizations o ON o.id = m.organization_id
               ORDER BY u.created_at DESC LIMIT 10`),

        many(`SELECT p.id, p.amount, p.status, p.purpose, p.created_at AS "createdAt",
                     p.card_brand AS "cardBrand", p.card_last4 AS "cardLast4",
                     o.name AS "orgName"
                FROM payments p
                JOIN organizations o ON o.id = p.organization_id
               ORDER BY p.created_at DESC LIMIT 10`)
      ]);

    const recurring = live.reduce((sum, s) => sum + pricing.monthlyValue(s.cycle, s.seats), 0);

    res.json({
      users,
      subscriptions: subs,
      revenue: {
        allTime: Number(money.total),
        last30: Number(money.last30),
        failed30: money.failed30,
        monthlyRecurring: Math.round(recurring),
        annualRunRate: Math.round(recurring * 12)
      },
      trends: {
        signups: signupTrend.map((r) => ({ day: r.day, count: r.count })),
        revenue: revenueTrend.map((r) => ({ month: r.month, amount: Number(r.amount) }))
      },
      expiring,
      recentUsers,
      recentPayments
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// USERS
// =========================================================================

// Sort is chosen from this map rather than interpolated from the query
// string — the one place a list endpoint usually grows an injection.
const USER_SORTS = {
  created: 'u.created_at',
  name: 'u.full_name',
  email: 'u.email',
  org: 'org_name',
  lastLogin: 'u.last_login_at',
  status: 'u.status',
  expires: 'period_end'
};

function userListQuery(req) {
  const params = [];
  const where = [];

  const q = String(req.query.q || '').trim();
  if (q) {
    params.push('%' + q + '%');
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR o.name ILIKE $${params.length})`);
  }

  if (USER_STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`u.status = $${params.length}`);
  }

  if (SUB_FILTERS.includes(req.query.sub)) {
    params.push(req.query.sub);
    where.push(`${EFFECTIVE_STATUS} = $${params.length}`);
  }

  if (req.query.book === 'sme' || req.query.book === 'church') {
    params.push(req.query.book);
    where.push(`o.book_type = $${params.length}`);
  }

  if (req.query.cycle === 'monthly' || req.query.cycle === 'annual') {
    params.push(req.query.cycle);
    where.push(`s.cycle = $${params.length}`);
  }

  const column = USER_SORTS[req.query.sort] || USER_SORTS.created;
  const direction = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const from = `FROM users u
     LEFT JOIN LATERAL (SELECT m.organization_id, m.role FROM memberships m
                         WHERE m.user_id = u.id ORDER BY m.created_at LIMIT 1) m ON true
     LEFT JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN subscriptions s ON s.organization_id = o.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;

  const select = `SELECT u.id, u.full_name AS name, u.email, u.auth_provider AS provider,
            u.status, u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt",
            u.login_count AS "loginCount",
            o.id AS "orgId", o.name AS org_name, o.book_type AS book, m.role,
            s.cycle, s.seats, s.trial_start AS "trialStart", s.status AS "subStatus",
            s.card_brand AS "cardBrand", s.card_last4 AS "cardLast4",
            ${PERIOD_END} AS period_end,
            ${EFFECTIVE_STATUS} AS "subscription",
            (COUNT(*) OVER ())::int AS total_count
     ${from}
     ORDER BY ${column} ${direction} NULLS LAST, u.created_at DESC`;

  return { select, params, order: column + ' ' + direction };
}

function shapeUserRow(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    provider: r.provider,
    status: r.status,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
    loginCount: r.loginCount,
    orgId: r.orgId,
    orgName: r.org_name,
    book: r.book,
    role: r.role,
    cycle: r.cycle,
    seats: r.seats,
    trialStart: r.trialStart,
    subscription: r.subscription,
    periodEnd: r.period_end,
    amount: r.cycle ? pricing.amountFor(r.cycle, r.seats) : 0,
    card: r.cardLast4 ? { brand: r.cardBrand, last4: r.cardLast4 } : null
  };
}

router.get('/users', async (req, res, next) => {
  try {
    const { select, params } = userListQuery(req);
    const p = page(req);
    const rows = await many(select + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      p.size,
      p.offset
    ]);
    res.json({
      users: rows.map(shapeUserRow),
      total: rows.length ? rows[0].total_count : 0,
      page: p.number,
      pageSize: p.size
    });
  } catch (err) {
    next(err);
  }
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/users.csv', async (req, res, next) => {
  try {
    const { select, params } = userListQuery(req);
    const rows = await many(select + ' LIMIT 10000', params);
    const header = [
      'Name', 'Email', 'Sign-in', 'Account status', 'Registered', 'Last login', 'Logins',
      'Organisation', 'Books', 'Role', 'Plan', 'Seats', 'Amount', 'Subscription', 'Period ends'
    ];
    const lines = [header.join(',')];
    for (const r of rows.map(shapeUserRow)) {
      lines.push([
        r.name, r.email, r.provider, r.status, r.createdAt, r.lastLoginAt, r.loginCount,
        r.orgName, r.book, r.role, r.cycle, r.seats, r.amount, r.subscription, r.periodEnd
      ].map(csvCell).join(','));
    }
    await adminAudit(req, 'admin.users.exported', 'users', null, { rows: rows.length });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="profitna-users.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'No such user.' });

    const user = await one(
      `SELECT id, full_name AS name, email, auth_provider AS provider, status,
              status_reason AS "statusReason", status_changed_at AS "statusChangedAt",
              created_at AS "createdAt", last_login_at AS "lastLoginAt",
              last_login_ip AS "lastLoginIp", login_count AS "loginCount"
         FROM users WHERE id = $1`,
      [id]
    );
    if (!user) return res.status(404).json({ error: 'No such user.' });

    const organisations = await many(
      `SELECT o.id, o.name, o.book_type AS book, o.business_type AS "businessType",
              o.created_at AS "createdAt", m.role, m.created_at AS "joinedAt",
              s.id AS "subscriptionId", s.cycle, s.seats, s.status AS "storedStatus",
              s.trial_start AS "trialStart", s.current_period_start AS "periodStart",
              s.cancelled_at AS "cancelledAt", s.provider,
              s.card_brand AS "cardBrand", s.card_last4 AS "cardLast4", s.card_exp AS "cardExp",
              ${PERIOD_END} AS "periodEnd", ${EFFECTIVE_STATUS} AS subscription,
              (SELECT COUNT(*)::int FROM memberships mm WHERE mm.organization_id = o.id) AS members
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN subscriptions s ON s.organization_id = o.id
        WHERE m.user_id = $1
        ORDER BY m.created_at`,
      [id]
    );

    const orgIds = organisations.map((o) => o.id);
    const payments = orgIds.length
      ? await many(
          `SELECT p.id, p.amount, p.currency, p.status, p.purpose, p.provider,
                  p.provider_reference AS reference, p.channel,
                  p.card_brand AS "cardBrand", p.card_last4 AS "cardLast4",
                  p.paid_at AS "paidAt", p.created_at AS "createdAt", o.name AS "orgName"
             FROM payments p JOIN organizations o ON o.id = p.organization_id
            WHERE p.organization_id = ANY($1) ORDER BY p.created_at DESC LIMIT 100`,
          [orgIds]
        )
      : [];

    const activity = await many(
      `SELECT a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.detail, a.created_at AS "createdAt", o.name AS "orgName"
         FROM audit_log a JOIN organizations o ON o.id = a.organization_id
        WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [id]
    );

    const administration = await many(
      `SELECT action, admin_email AS "adminEmail", detail, created_at AS "createdAt"
         FROM platform_audit_log
        WHERE target_type = 'user' AND target_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [id]
    );

    res.json({
      user,
      organisations: organisations.map((o) =>
        Object.assign(o, { amount: o.cycle ? pricing.amountFor(o.cycle, o.seats) : 0 })
      ),
      payments,
      activity,
      administration
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const status = String((req.body || {}).status || '');
    const reason = String((req.body || {}).reason || '').slice(0, 500) || null;
    if (!USER_STATUSES.includes(status)) {
      return bad(res, 'Status must be one of: ' + USER_STATUSES.join(', ') + '.');
    }

    const before = await one('SELECT id, email, status FROM users WHERE id = $1', [id]);
    if (!before) return res.status(404).json({ error: 'No such user.' });

    const user = await one(
      `UPDATE users SET status = $2, status_reason = $3, status_changed_at = now()
        WHERE id = $1
    RETURNING id, full_name AS name, email, status, status_reason AS "statusReason",
              status_changed_at AS "statusChangedAt"`,
      [id, status, reason]
    );

    await adminAudit(req, 'user.status.' + status, 'user', id, {
      email: before.email,
      from: before.status,
      to: status,
      reason
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// SUBSCRIPTIONS
// =========================================================================

const SUB_SORTS = {
  created: 's.created_at',
  org: 'org_name',
  expires: 'period_end',
  amount: 's.seats',
  status: 'status_sort'
};

router.get('/subscriptions', async (req, res, next) => {
  try {
    const params = [];
    const where = [];

    const q = String(req.query.q || '').trim();
    if (q) {
      params.push('%' + q + '%');
      where.push(`o.name ILIKE $${params.length}`);
    }
    if (SUB_FILTERS.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`${EFFECTIVE_STATUS} = $${params.length}`);
    }
    if (req.query.cycle === 'monthly' || req.query.cycle === 'annual') {
      params.push(req.query.cycle);
      where.push(`s.cycle = $${params.length}`);
    }
    if (req.query.expiring === 'true') {
      where.push(`${PERIOD_END} BETWEEN CURRENT_DATE AND CURRENT_DATE + 14`);
    }

    const column = SUB_SORTS[req.query.sort] || SUB_SORTS.expires;
    const direction = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const p = page(req);

    const rows = await many(
      `SELECT s.id, s.cycle, s.seats, s.status AS "storedStatus",
              s.trial_start AS "trialStart", s.current_period_start AS "periodStart",
              s.cancelled_at AS "cancelledAt", s.created_at AS "createdAt",
              s.card_brand AS "cardBrand", s.card_last4 AS "cardLast4",
              o.id AS "orgId", o.name AS org_name, o.book_type AS book,
              ${PERIOD_END} AS period_end,
              ${EFFECTIVE_STATUS} AS status,
              ${EFFECTIVE_STATUS} AS status_sort,
              (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
                WHERE m.organization_id = o.id ORDER BY m.created_at LIMIT 1) AS email,
              (SELECT COALESCE(SUM(amount), 0) FROM payments pay
                WHERE pay.organization_id = o.id AND pay.status = 'success') AS paid,
              (COUNT(*) OVER ())::int AS total_count
         FROM subscriptions s
         JOIN organizations o ON o.id = s.organization_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${column} ${direction} NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.size, p.offset]
    );

    res.json({
      subscriptions: rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        orgName: r.org_name,
        book: r.book,
        email: r.email,
        cycle: r.cycle,
        seats: r.seats,
        amount: pricing.amountFor(r.cycle, r.seats),
        status: r.status,
        storedStatus: r.storedStatus,
        trialStart: r.trialStart,
        periodStart: r.periodStart,
        periodEnd: r.period_end,
        cancelledAt: r.cancelledAt,
        createdAt: r.createdAt,
        paid: Number(r.paid),
        card: r.cardLast4 ? { brand: r.cardBrand, last4: r.cardLast4 } : null
      })),
      total: rows.length ? rows[0].total_count : 0,
      page: p.number,
      pageSize: p.size
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/subscriptions/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const current = await one(
      `SELECT s.*, o.name AS org_name FROM subscriptions s
         JOIN organizations o ON o.id = s.organization_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!current) return res.status(404).json({ error: 'No such subscription.' });

    const status = b.status === undefined ? current.status : String(b.status);
    if (!SUB_STATUSES.includes(status)) {
      return bad(res, 'Status must be one of: ' + SUB_STATUSES.join(', ') + '.');
    }
    const cycle = b.cycle === 'monthly' || b.cycle === 'annual' ? b.cycle : current.cycle;
    const seats = b.seats === undefined ? current.seats : Math.min(25, Math.max(1, parseInt(b.seats, 10) || 1));

    let periodEnd = current.current_period_end;
    if (b.periodEnd !== undefined) {
      const value = String(b.periodEnd || '');
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad(res, 'Give the period end as YYYY-MM-DD.');
      periodEnd = value || null;
    }

    const updated = await one(
      `UPDATE subscriptions
          SET status = $2, cycle = $3, seats = $4, current_period_end = $5,
              cancelled_at  = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE NULL END,
              suspended_at  = CASE WHEN $2 = 'suspended' THEN COALESCE(suspended_at, now()) ELSE NULL END
        WHERE id = $1
    RETURNING *`,
      [current.id, status, cycle, seats, periodEnd]
    );

    await adminAudit(req, 'subscription.updated', 'subscription', current.id, {
      organisation: current.org_name,
      from: { status: current.status, cycle: current.cycle, seats: current.seats, periodEnd: current.current_period_end },
      to: { status, cycle, seats, periodEnd }
    });

    res.json({
      subscription: {
        id: updated.id,
        status: updated.status,
        cycle: updated.cycle,
        seats: updated.seats,
        periodEnd: updated.current_period_end,
        amount: pricing.amountFor(updated.cycle, updated.seats)
      }
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// AUTOMATIC BILLING
// =========================================================================

router.get('/billing', async (req, res, next) => {
  try {
    const [last, waiting, ready, recent] = await Promise.all([
      billing.lastRun(),
      billing.outstanding(),
      billing.due(200),
      many(
        `SELECT id, trigger, started_at AS "startedAt", finished_at AS "finishedAt",
                considered, charged, failed, amount, error
           FROM billing_runs ORDER BY started_at DESC LIMIT 10`
      )
    ]);

    res.json({
      scheduler: {
        on: billing.enabled(),
        everyMinutes: Math.round(billing.intervalMs() / 60000),
        processor: paystack.configured(),
        maxAttempts: billing.MAX_ATTEMPTS,
        retryDays: billing.RETRY_DAYS
      },
      lastRun: last,
      // What the next pass would attempt, versus everything overdue including
      // the subscriptions sitting out a retry window.
      dueNow: ready.length,
      outstanding: waiting.map((w) => Object.assign(w, { amount: undefined })),
      runs: recent.map((r) => Object.assign(r, { amount: Number(r.amount) }))
    });
  } catch (err) {
    next(err);
  }
});

// The same pass the timer runs, on demand. Useful on the day you go live, and
// after fixing whatever stopped a charge going through.
router.post('/billing/run', async (req, res, next) => {
  try {
    const result = await billing.runOnce('manual');
    await adminAudit(req, 'billing.run', 'billing_run', result.id, {
      considered: result.considered,
      charged: result.charged,
      failed: result.failed,
      amount: result.amount,
      error: result.error
    });
    res.json({ run: result });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PAYMENTS
// =========================================================================

router.get('/payments', async (req, res, next) => {
  try {
    const params = [];
    const where = [];

    const q = String(req.query.q || '').trim();
    if (q) {
      params.push('%' + q + '%');
      where.push(`(o.name ILIKE $${params.length} OR p.provider_reference ILIKE $${params.length})`);
    }
    if (['success', 'failed', 'pending', 'refunded'].includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`p.status = $${params.length}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) {
      params.push(req.query.from);
      where.push(`p.created_at >= $${params.length}::date`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) {
      params.push(req.query.to);
      where.push(`p.created_at < $${params.length}::date + 1`);
    }

    const p = page(req);
    const rows = await many(
      `SELECT p.id, p.amount, p.currency, p.status, p.purpose, p.provider,
              p.provider_reference AS reference, p.channel,
              p.card_brand AS "cardBrand", p.card_last4 AS "cardLast4",
              p.paid_at AS "paidAt", p.created_at AS "createdAt",
              o.id AS "orgId", o.name AS "orgName",
              (COUNT(*) OVER ())::int AS total_count
         FROM payments p JOIN organizations o ON o.id = p.organization_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.size, p.offset]
    );

    const totals = await one(
      `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'success'), 0) AS collected,
              COUNT(*)::int AS count
         FROM payments p JOIN organizations o ON o.id = p.organization_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    );

    res.json({
      payments: rows.map((r) => Object.assign(r, { amount: Number(r.amount), total_count: undefined })),
      total: rows.length ? rows[0].total_count : 0,
      collected: Number(totals.collected),
      page: p.number,
      pageSize: p.size
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// ACTIVITY
// =========================================================================

router.get('/activity', async (req, res, next) => {
  try {
    const p = page(req);
    const scope = req.query.scope === 'tenant' ? 'tenant' : req.query.scope === 'platform' ? 'platform' : 'all';

    const platform =
      scope === 'tenant'
        ? []
        : await many(
            `SELECT 'platform' AS scope, action, admin_email AS actor, target_type AS "entityType",
                    target_id AS "entityId", detail, ip, created_at AS "createdAt", NULL AS "orgName"
               FROM platform_audit_log ORDER BY created_at DESC LIMIT $1`,
            [p.size]
          );

    const tenant =
      scope === 'platform'
        ? []
        : await many(
            `SELECT 'tenant' AS scope, a.action, u.email AS actor, a.entity_type AS "entityType",
                    a.entity_id AS "entityId", a.detail, NULL AS ip, a.created_at AS "createdAt",
                    o.name AS "orgName"
               FROM audit_log a
               LEFT JOIN users u ON u.id = a.user_id
               JOIN organizations o ON o.id = a.organization_id
              ORDER BY a.created_at DESC LIMIT $1`,
            [p.size]
          );

    const events = [...platform, ...tenant]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, p.size);

    res.json({ events });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
