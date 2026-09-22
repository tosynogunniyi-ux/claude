const express = require('express');
const bcrypt = require('bcryptjs');
const { one, tx } = require('../db');
const { issue, clear, requireAuth, recordLogin, SUSPENDED_MESSAGE } = require('../auth');
const { accessFor } = require('../access');
const { seedChartOfAccounts } = require('../defaults');
const { seedDemoBooks } = require('../demo');
const paystack = require('../integrations/paystack');
const google = require('../integrations/google');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOKS = ['sme', 'church'];
const CYCLES = ['monthly', 'annual'];

function bad(res, message) {
  return res.status(400).json({ error: message });
}

// The session object the UI keeps in state: same shape the prototype built
// locally at signup, plus the ids it now needs to talk to the API and the
// derived trial facts the banner and the paywall are drawn from.
async function sessionFor(userId) {
  const row = await one(
    `SELECT u.id            AS "userId",
            u.full_name     AS name,
            u.email,
            u.auth_provider AS provider,
            u.status,
            m.role,
            o.id            AS "orgId",
            o.name          AS "orgName",
            o.book_type     AS book,
            s.cycle,
            s.seats         AS users,
            s.trial_start   AS "trialStart",
            s.status        AS "subStatus",
            s.current_period_end,
            s.card_last4,
            CASE WHEN s.card_last4 IS NULL THEN NULL
                 ELSE json_build_object('brand', s.card_brand, 'last4', s.card_last4, 'exp', s.card_exp)
            END AS card
       FROM users u
       JOIN memberships m   ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN subscriptions s ON s.organization_id = o.id
      WHERE u.id = $1
      ORDER BY m.created_at
      LIMIT 1`,
    [userId]
  );
  if (!row) return null;

  // Whether the books open, how long is left and what it costs are all read
  // from the dates rather than stored, so the answer cannot go stale.
  const access = accessFor(
    row.cycle
      ? {
          cycle: row.cycle,
          seats: row.users,
          trial_start: row.trialStart,
          current_period_end: row.current_period_end,
          status: row.subStatus,
          card_last4: row.card_last4
        }
      : null
  );

  delete row.current_period_end;
  delete row.card_last4;

  return Object.assign(row, {
    access: access.state,
    accessReason: access.reason,
    onTrial: access.onTrial,
    daysLeft: access.daysLeft,
    trialEndsOn: access.trialEndsOn,
    periodEnd: access.periodEnd,
    amount: access.amount
  });
}

async function createAccount({ name, orgName, email, password, googleSub, book, cycle, seats }) {
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  return tx(async (client) => {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      const err = new Error('An account already exists for that email. Sign in instead.');
      err.status = 409;
      throw err;
    }

    const user = (await client.query(
      `INSERT INTO users (email, password_hash, full_name, auth_provider, google_sub)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, passwordHash, name, googleSub ? 'google' : 'password', googleSub || null]
    )).rows[0];

    const org = (await client.query(
      `INSERT INTO organizations (name, book_type, business_type, vat_rate)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        orgName,
        book,
        book === 'church' ? 'Registered Trustees' : 'Limited Company',
        book === 'church' ? 0 : 7.5
      ]
    )).rows[0];

    // The person who creates the books owns them.
    await client.query(
      "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')",
      [user.id, org.id]
    );

    // No card, no processor, no charge. trial_start defaults to today and the
    // status to 'trialing', which is the whole of what a new account owes us.
    await client.query(
      'INSERT INTO subscriptions (organization_id, cycle, seats) VALUES ($1, $2, $3)',
      [org.id, cycle, seats]
    );

    await seedChartOfAccounts(client, org.id, book);
    if (process.env.SEED_DEMO_DATA === 'true') {
      await seedDemoBooks(client, org.id, book);
    }

    await client.query(
      `INSERT INTO audit_log (organization_id, user_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'account.created', 'organization', $3)`,
      [org.id, user.id, org.id]
    );

    return user.id;
  });
}

router.post('/signup', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const orgName = String(body.org || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const book = String(body.book || '');
    const cycle = CYCLES.includes(body.cycle) ? body.cycle : 'monthly';
    const seats = Math.min(25, Math.max(1, parseInt(body.users, 10) || 1));

    if (!name) return bad(res, 'Enter your full name.');
    if (!orgName) return bad(res, 'Enter the name of your business or organisation.');
    if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address.');
    if (!BOOKS.includes(book)) return bad(res, 'Choose the set of books you will keep.');

    // A Google signup carries a verified ID token instead of a password.
    let googleSub = null;
    let password = null;
    if (body.googleCredential) {
      const profile = await google.verify(body.googleCredential);
      if (!profile) return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
      if (profile.email !== email) return bad(res, 'That Google account does not match the email you entered.');
      googleSub = profile.sub;
    } else {
      password = String(body.password || '');
      if (password.length < 8) return bad(res, 'Choose a password of at least 8 characters.');
    }

    // Signing up costs nothing and asks for nothing to pay with. The account
    // opens on a 14-day trial with no card on file; payment is collected at
    // the end of it, through /subscription/activate. Anything card-shaped in
    // the body is ignored rather than trusted.
    const userId = await createAccount({
      name, orgName, email, password, googleSub, book, cycle, seats,
      card: null, payment: null
    });
    await recordLogin(req, userId);
    issue(req, res, { id: userId, email });
    res.status(201).json({ session: await sessionFor(userId) });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address.');
    if (!password) return bad(res, 'Enter your password.');

    const user = await one('SELECT id, email, password_hash, status FROM users WHERE email = $1', [email]);
    // Same message either way, so the response cannot be used to enumerate
    // which emails have accounts.
    const ok = user && user.password_hash && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'That email and password do not match an account.' });
    // Told only once the password is right: whether an account is suspended
    // is the account holder's business, not a probe's.
    if (user.status !== 'active') {
      return res.status(403).json({ error: SUSPENDED_MESSAGE[user.status] || SUSPENDED_MESSAGE.suspended });
    }

    await recordLogin(req, user.id);
    issue(req, res, user);
    res.json({ session: await sessionFor(user.id) });
  } catch (err) {
    next(err);
  }
});

// Google sign-in for an account that already exists. Signup goes through
// /signup with the same credential, because it also needs book and plan.
router.post('/google', async (req, res, next) => {
  try {
    const profile = await google.verify((req.body || {}).credential);
    if (!profile) return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });

    const user = await one('SELECT id, email, google_sub, status FROM users WHERE email = $1', [profile.email]);
    if (!user) {
      return res.status(404).json({ error: 'No Profitna account uses that Google address. Create one first.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: SUSPENDED_MESSAGE[user.status] || SUSPENDED_MESSAGE.suspended });
    }
    if (!user.google_sub) {
      const { query } = require('../db');
      await query("UPDATE users SET google_sub = $1, auth_provider = 'google' WHERE id = $2", [profile.sub, user.id]);
    }
    await recordLogin(req, user.id);
    issue(req, res, user);
    res.json({ session: await sessionFor(user.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ session: await sessionFor(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/signout', (req, res) => {
  clear(req, res);
  res.json({ ok: true });
});

// Lets the sign-in screen hide provider buttons that this deployment cannot
// actually complete, rather than offering a dead control.
router.get('/config', (req, res) => {
  res.json({
    google: google.configured(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    paystack: paystack.configured(),
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || null
  });
});

module.exports = { router, sessionFor };
