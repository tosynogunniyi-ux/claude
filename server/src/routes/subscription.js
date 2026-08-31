const express = require('express');
const { one, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const paystack = require('../integrations/paystack');

const router = express.Router({ mergeParams: true });

const PER_USER_MONTHLY = 5000;
const PER_USER_ANNUAL = 57000;

function view(sub) {
  const rate = sub.cycle === 'monthly' ? PER_USER_MONTHLY : PER_USER_ANNUAL;
  return {
    cycle: sub.cycle,
    users: sub.seats,
    trialStart: sub.trial_start,
    status: sub.status,
    amount: rate * sub.seats,
    card: sub.card_last4 ? { brand: sub.card_brand, last4: sub.card_last4, exp: sub.card_exp } : null
  };
}

router.get('/subscription', requireOrg(), async (req, res, next) => {
  try {
    const sub = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [req.orgId]);
    if (!sub) return res.status(404).json({ error: 'No subscription on this organisation.' });
    res.json({ subscription: view(sub) });
  } catch (err) {
    next(err);
  }
});

// Cycle and seat changes apply from the next charge, so nothing is billed here.
router.patch('/subscription', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const current = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [req.orgId]);
    if (!current) return res.status(404).json({ error: 'No subscription on this organisation.' });

    const cycle = b.cycle === 'monthly' || b.cycle === 'annual' ? b.cycle : current.cycle;
    const seats = b.users === undefined
      ? current.seats
      : Math.min(25, Math.max(1, parseInt(b.users, 10) || 1));

    const updated = await one(
      'UPDATE subscriptions SET cycle = $2, seats = $3 WHERE organization_id = $1 RETURNING *',
      [req.orgId, cycle, seats]
    );
    await audit(req.orgId, req.user.id, 'subscription.updated', 'subscription', updated.id, { cycle, seats });
    res.json({ subscription: view(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/subscription/cancel', requireOrg('admin'), async (req, res, next) => {
  try {
    const updated = await one(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = now() WHERE organization_id = $1 RETURNING *",
      [req.orgId]
    );
    if (!updated) return res.status(404).json({ error: 'No subscription on this organisation.' });
    await audit(req.orgId, req.user.id, 'subscription.cancelled', 'subscription', updated.id);
    res.json({ subscription: view(updated) });
  } catch (err) {
    next(err);
  }
});

// Charges the stored card. Runs when a trial ends or a term renews — call it
// from a scheduler once the deployment has a live Paystack key.
async function chargeDue(organizationId) {
  const sub = await one(
    `SELECT s.*, o.name AS org_name,
            (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.organization_id = s.organization_id AND m.role = 'admin'
              ORDER BY m.created_at LIMIT 1) AS email
       FROM subscriptions s JOIN organizations o ON o.id = s.organization_id
      WHERE s.organization_id = $1`,
    [organizationId]
  );
  if (!sub || sub.status === 'cancelled') return { charged: false, reason: 'not billable' };
  if (!paystack.configured() || !sub.provider_authorization_code) {
    return { charged: false, reason: 'no payment processor configured' };
  }

  const rate = sub.cycle === 'monthly' ? PER_USER_MONTHLY : PER_USER_ANNUAL;
  const result = await paystack.chargeAuthorization({
    authorizationCode: sub.provider_authorization_code,
    email: sub.email,
    amountNaira: rate * sub.seats,
    reference: 'profitna-' + organizationId + '-' + Date.now()
  });

  await query('UPDATE subscriptions SET status = $2 WHERE organization_id = $1', [
    organizationId,
    result.ok ? 'active' : 'past_due'
  ]);
  return { charged: result.ok };
}

// Paystack posts here. Signature is verified over the raw body, so this route
// is mounted with the raw body parser rather than the JSON one.
async function paystackWebhook(req, res, next) {
  try {
    if (!paystack.configured()) return res.status(501).end();
    if (!paystack.verifyWebhook(req.body, req.get('x-paystack-signature'))) {
      return res.status(401).json({ error: 'Bad signature.' });
    }

    const event = JSON.parse(req.body.toString('utf8'));
    const code = event.data && event.data.authorization && event.data.authorization.authorization_code;
    if (code) {
      const status = event.event === 'charge.success' ? 'active'
        : event.event === 'invoice.payment_failed' ? 'past_due'
        : null;
      if (status) {
        await query('UPDATE subscriptions SET status = $2 WHERE provider_authorization_code = $1', [code, status]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { router, chargeDue, paystackWebhook, PER_USER_MONTHLY, PER_USER_ANNUAL };
