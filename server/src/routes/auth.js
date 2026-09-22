const express = require('express');
const bcrypt = require('bcryptjs');
const { one, tx } = require('../db');
const { issue, clear, requireAuth } = require('../auth');
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
// locally at signup, plus the ids it now needs to talk to the API.
async function sessionFor(userId) {
  return one(
    `SELECT u.id            AS "userId",
            u.full_name     AS name,
            u.email,
            u.auth_provider AS provider,
            m.role,
            o.id            AS "orgId",
            o.name          AS "orgName",
            o.book_type     AS book,
            s.cycle,
            s.seats         AS users,
            s.trial_start   AS "trialStart",
            s.status        AS "subStatus",
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
}

async function createAccount({ name, orgName, email, password, googleSub, book, cycle, seats, card, payment }) {
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

    await client.query(
      `INSERT INTO subscriptions
         (organization_id, cycle, seats, card_brand, card_last4, card_exp, provider,
          provider_customer_id, provider_authorization_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        org.id, cycle, seats,
        card ? card.brand : null,
        card ? card.last4 : null,
        card ? card.exp : null,
        payment ? payment.provider : null,
        payment ? payment.customerId : null,
        payment ? payment.authorizationCode : null
      ]
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

    // Card details are captured by the payment processor, never by this
    // server: the client sends back only what the UI displays.
    const card = body.card
      ? {
          brand: String(body.card.brand || '').slice(0, 32),
          last4: String(body.card.last4 || '').replace(/\D/g, '').slice(-4),
          exp: String(body.card.exp || '').slice(0, 7)
        }
      : null;
    if (card && card.last4.length !== 4) return bad(res, 'Add a payment card before starting the trial.');
    if (!card) return bad(res, 'Add a payment card before starting the trial.');

    // With Paystack configured the client charges through their SDK first and
    // passes the reference here for server-side verification.
    let payment = null;
    if (body.paymentReference) {
      payment = await paystack.verify(body.paymentReference, email);
      if (!payment) return bad(res, 'We could not verify that card with the payment processor.');
    }

    const userId = await createAccount({ name, orgName, email, password, googleSub, book, cycle, seats, card, payment });
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

    const user = await one('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    // Same message either way, so the response cannot be used to enumerate
    // which emails have accounts.
    const ok = user && user.password_hash && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'That email and password do not match an account.' });

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

    const user = await one('SELECT id, email, google_sub FROM users WHERE email = $1', [profile.email]);
    if (!user) {
      return res.status(404).json({ error: 'No Profitna account uses that Google address. Create one first.' });
    }
    if (!user.google_sub) {
      const { query } = require('../db');
      await query("UPDATE users SET google_sub = $1, auth_provider = 'google' WHERE id = $2", [profile.sub, user.id]);
    }
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
