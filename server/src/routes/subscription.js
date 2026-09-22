const express = require('express');
const { one, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const paystack = require('../integrations/paystack');
const { PER_USER_MONTHLY, PER_USER_ANNUAL, amountFor } = require('../pricing');

const router = express.Router({ mergeParams: true });

function view(sub) {
  return {
    cycle: sub.cycle,
    users: sub.seats,
    trialStart: sub.trial_start,
    status: sub.status,
    amount: amountFor(sub.cycle, sub.seats),
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

// Charges the stored card once, for one organisation. Deciding *when* that
// should happen is src/billing.js; this only does it and reports what
// happened, so the same function serves the scheduler and the owner's
// "run now" button.
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
  if (!sub || sub.status === 'cancelled' || sub.status === 'suspended') {
    return { charged: false, reason: 'not billable' };
  }
  if (!paystack.configured()) return { charged: false, reason: 'no payment processor configured' };
  if (!sub.provider_authorization_code) return { charged: false, reason: 'no card on file' };

  const amount = amountFor(sub.cycle, sub.seats);
  const reference = 'profitna-' + organizationId + '-' + Date.now();

  let result;
  try {
    result = await paystack.chargeAuthorization({
      authorizationCode: sub.provider_authorization_code,
      email: sub.email,
      amountNaira: amount,
      reference
    });
  } catch (err) {
    // Paystack unreachable is not a declined card: nothing was charged, so
    // say so plainly and let the scheduler try again rather than recording a
    // failure against the customer.
    return { charged: false, reason: 'could not reach the payment processor: ' + err.message, amount };
  }

  const message = (result.body && result.body.message) || 'charge declined';

  // Recorded either way. A failed renewal is exactly what the owner needs to
  // see in the console, and a history that only holds successes hides it.
  await recordPayment({
    organizationId,
    reference,
    purpose: 'renewal',
    amount,
    status: result.ok ? 'success' : 'failed',
    cardBrand: sub.card_brand,
    cardLast4: sub.card_last4,
    detail: result.ok ? null : { message }
  });

  if (result.ok) {
    await rollPeriod(organizationId, sub.cycle);
  } else {
    await query("UPDATE subscriptions SET status = 'past_due' WHERE organization_id = $1", [organizationId]);
  }

  await audit(
    organizationId,
    null,
    result.ok ? 'subscription.charged' : 'subscription.charge_failed',
    'subscription',
    sub.id,
    result.ok ? { amount, cycle: sub.cycle, seats: sub.seats } : { amount, reason: message }
  );

  return { charged: result.ok, amount, reason: result.ok ? null : message };
}

// A term starts today and ends one cycle out. Stored, because a renewal date
// is a fact about a charge that happened — unlike expiry, which is read from
// this date and the calendar.
async function rollPeriod(organizationId, cycle) {
  await query(
    `UPDATE subscriptions
        SET status = 'active',
            current_period_start = CURRENT_DATE,
            current_period_end = (CURRENT_DATE +
              CASE WHEN $2 = 'annual' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END)::date
      WHERE organization_id = $1`,
    [organizationId, cycle || 'monthly']
  );
}

async function recordPayment(p) {
  await query(
    `INSERT INTO payments (organization_id, provider, provider_reference, purpose, amount,
                           currency, status, channel, card_brand, card_last4, paid_at, detail)
     VALUES ($1, 'paystack', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     -- The webhook is the later, authoritative word on a reference chargeDue
     -- already wrote, so it corrects the row rather than being dropped. A
     -- retried webhook rewrites the same values, which changes nothing.
     ON CONFLICT (provider, provider_reference) DO UPDATE
       SET status  = EXCLUDED.status,
           paid_at = COALESCE(EXCLUDED.paid_at, payments.paid_at),
           channel = COALESCE(EXCLUDED.channel, payments.channel),
           detail  = EXCLUDED.detail`,
    [
      p.organizationId,
      p.reference,
      p.purpose || 'subscription',
      p.amount || 0,
      p.currency || 'NGN',
      p.status || 'success',
      p.channel || null,
      p.cardBrand || null,
      p.cardLast4 || null,
      p.paidAt || (p.status === 'success' ? new Date().toISOString() : null),
      p.detail ? JSON.stringify(p.detail) : null
    ]
  );
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
    const data = event.data || {};
    const auth = data.authorization || {};
    const code = auth.authorization_code;

    if (code) {
      const sub = await one('SELECT * FROM subscriptions WHERE provider_authorization_code = $1', [code]);
      if (sub) {
        const succeeded = event.event === 'charge.success';
        const failed = event.event === 'invoice.payment_failed' || event.event === 'charge.failed';

        if (succeeded || failed) {
          // Paystack retries webhooks, and chargeDue may already have written
          // this same reference — the unique constraint makes the second one
          // a no-op rather than a duplicate line in the customer's history.
          await recordPayment({
            organizationId: sub.organization_id,
            reference: data.reference || null,
            purpose: 'subscription',
            amount: Number(data.amount || 0) / 100,
            currency: data.currency || 'NGN',
            status: succeeded ? 'success' : 'failed',
            channel: data.channel || null,
            cardBrand: auth.brand || sub.card_brand,
            cardLast4: auth.last4 || sub.card_last4,
            paidAt: data.paid_at || null,
            detail: succeeded ? null : { event: event.event, message: data.gateway_response || null }
          });
        }

        if (succeeded) await rollPeriod(sub.organization_id, sub.cycle);
        else if (failed) {
          await query("UPDATE subscriptions SET status = 'past_due' WHERE id = $1", [sub.id]);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { router, chargeDue, paystackWebhook, PER_USER_MONTHLY, PER_USER_ANNUAL };
