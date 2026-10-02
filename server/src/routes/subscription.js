const express = require('express');
const { one, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const paystack = require('../integrations/paystack');
const monnify = require('../integrations/monnify');
const gateway = require('../integrations/gateway');
const { PER_USER_MONTHLY, PER_USER_ANNUAL, TRIAL_DAYS, amountFor } = require('../pricing');
const team = require('../team');

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

    // Seats are people. Dropping below the number already on the books would
    // leave someone paying for nothing or, worse, silently locked out.
    if (seats < current.seats) {
      const use = await team.seatUse(req.orgId);
      if (seats < use.used) {
        return res.status(409).json({
          error: 'These books already use ' + use.used +
            (use.pending ? ' seats, counting ' + use.pending + ' invitation' + (use.pending === 1 ? '' : 's') : ' seats') +
            '. Remove someone first.'
        });
      }
    }

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

// The other end of the card-free trial: the customer pays here, once the
// trial has run out, and the books open again. The browser has already paid
// through the processor's own window, so all that arrives is a reference — the
// amount, the card and the reusable credential all come from verifying it,
// never from the client.
async function activate(organizationId, { reference, email, userId }) {
  const sub = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [organizationId]);
  if (!sub) return { ok: false, status: 404, error: 'No subscription on this organisation.' };
  if (sub.status === 'suspended') {
    return { ok: false, status: 403, error: 'This account is suspended. Contact support@profitna.com.' };
  }
  if (!gateway.configured()) {
    return { ok: false, status: 501, error: 'Payments are not configured on this server.' };
  }
  if (!reference) return { ok: false, status: 400, error: 'Complete the payment before activating.' };

  const provider = gateway.name();
  const payment = await gateway.verify(reference, email);
  if (!payment) {
    return {
      ok: false,
      status: 400,
      error: 'We could not verify that payment with ' +
        (provider === 'monnify' ? 'Monnify' : 'Paystack') +
        '. Nothing has been charged twice.'
    };
  }

  const expected = amountFor(sub.cycle, sub.seats);
  if (Number(payment.amount) < expected) {
    return {
      ok: false,
      status: 400,
      error: 'That payment was ' + Math.round(payment.amount) + ' naira, and this plan costs ' + expected + '.'
    };
  }

  await query(
    `UPDATE subscriptions
        SET provider = $7,
            provider_customer_id = COALESCE($2, provider_customer_id),
            provider_authorization_code = COALESCE($3, provider_authorization_code),
            card_brand = COALESCE($4, card_brand),
            card_last4 = COALESCE($5, card_last4),
            card_exp   = COALESCE($6, card_exp),
            charge_attempts = 0, next_charge_attempt_at = NULL, last_charge_error = NULL
      WHERE organization_id = $1`,
    [
      organizationId,
      payment.customerId,
      payment.authorizationCode,
      payment.card ? payment.card.brand : null,
      payment.card ? payment.card.last4 : null,
      payment.card ? payment.card.exp : null,
      payment.provider || provider
    ]
  );

  await recordPayment({
    organizationId,
    provider: payment.provider || provider,
    reference: payment.reference,
    purpose: 'subscription',
    amount: payment.amount,
    currency: payment.currency,
    status: 'success',
    channel: payment.channel,
    cardBrand: payment.card ? payment.card.brand : null,
    cardLast4: payment.card ? payment.card.last4 : null,
    paidAt: payment.paidAt
  });

  // Sets status active and starts the term today, which is what reopens the
  // books — access is read from the period end, not from a flag.
  await rollPeriod(organizationId, sub.cycle);
  await audit(organizationId, userId || null, 'subscription.activated', 'subscription', sub.id, {
    amount: payment.amount,
    cycle: sub.cycle,
    seats: sub.seats
  });

  return { ok: true };
}

router.post('/subscription/activate', requireOrg('admin'), async (req, res, next) => {
  try {
    const result = await activate(req.orgId, {
      reference: String((req.body || {}).paymentReference || ''),
      email: req.user.email,
      userId: req.user.id
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    const updated = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [req.orgId]);
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
  if (!gateway.configured()) return { charged: false, reason: 'no payment processor configured' };
  if (!sub.provider_authorization_code) return { charged: false, reason: 'no card on file' };

  // A card stored with one processor cannot be charged through another: the
  // token means nothing to them. Say so plainly instead of sending it over and
  // recording a decline against a customer whose card is fine.
  const provider = gateway.name();
  if (sub.provider && sub.provider !== provider) {
    return {
      charged: false,
      reason: 'card on file belongs to ' + sub.provider + ' and this server now bills through ' + provider
    };
  }

  const amount = amountFor(sub.cycle, sub.seats);
  const reference = 'profitna-' + organizationId + '-' + Date.now();

  let result;
  try {
    result = await gateway.chargeAuthorization({
      authorizationCode: sub.provider_authorization_code,
      email: sub.email,
      name: sub.org_name,
      amountNaira: amount,
      reference
    });
  } catch (err) {
    // The processor being unreachable is not a declined card: nothing was
    // charged, so say so plainly and let the scheduler try again rather than
    // recording a failure against the customer.
    return { charged: false, reason: 'could not reach the payment processor: ' + err.message, amount };
  }

  const message = (result.body && result.body.message) || 'charge declined';

  // Recorded either way. A failed renewal is exactly what the owner needs to
  // see in the console, and a history that only holds successes hides it.
  await recordPayment({
    organizationId,
    provider,
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

// A term starts where access currently runs out, or today if that is already
// past. Stored, because a renewal date is a fact about a charge that happened
// — unlike expiry, which is read from this date and the calendar.
//
// The GREATEST is what makes paying early safe. Somebody who subscribes with
// four days of trial left keeps those four days and their month starts after
// them, which is what the trial banner has always promised: "your books keep
// running from <trial end>". Starting the term today instead would quietly
// bill them for days they had already been given.
//
// It also means a renewal charged a day late does not shorten the term, and
// that paying twice by accident buys two months rather than losing one.
const PERIOD_START =
  `GREATEST(CURRENT_DATE, COALESCE(current_period_end, trial_start + ${TRIAL_DAYS}))`;

async function rollPeriod(organizationId, cycle) {
  await query(
    `UPDATE subscriptions
        SET status = 'active',
            current_period_start = ${PERIOD_START},
            current_period_end = (${PERIOD_START} +
              CASE WHEN $2 = 'annual' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END)::date
      WHERE organization_id = $1`,
    [organizationId, cycle || 'monthly']
  );
}

async function recordPayment(p) {
  await query(
    `INSERT INTO payments (organization_id, provider, provider_reference, purpose, amount,
                           currency, status, channel, card_brand, card_last4, paid_at, detail)
     VALUES ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      p.detail ? JSON.stringify(p.detail) : null,
      p.provider || gateway.name()
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

// Monnify posts here. Signature is verified over the raw body, so this route
// is mounted with the raw body parser rather than the JSON one.
async function monnifyWebhook(req, res, next) {
  try {
    if (!monnify.configured()) return res.status(501).end();
    if (!monnify.verifyWebhook(req.body, req.get('monnify-signature'))) {
      return res.status(401).json({ error: 'Bad signature.' });
    }

    const event = JSON.parse(req.body.toString('utf8'));
    const data = event.eventData || {};
    const details = data.cardDetails || {};
    const type = String(event.eventType || '').toUpperCase();

    const succeeded = type === 'SUCCESSFUL_TRANSACTION' ||
      String(data.paymentStatus).toUpperCase() === 'PAID';
    const failed = type === 'FAILED_TRANSACTION' ||
      String(data.paymentStatus).toUpperCase() === 'FAILED';
    if (!succeeded && !failed) return res.json({ ok: true });

    // The card token identifies the subscription, exactly as Paystack's
    // authorization code does. A renewal we started ourselves also carries our
    // own reference, which names the organisation directly — worth falling
    // back to, because a decline is the case where the token may be the very
    // thing that stopped working.
    let sub = details.cardToken
      ? await one('SELECT * FROM subscriptions WHERE provider_authorization_code = $1', [details.cardToken])
      : null;
    if (!sub) {
      const mine = /^profitna-([0-9a-f-]{36})-\d+$/i.exec(String(data.paymentReference || ''));
      if (mine) sub = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [mine[1]]);
    }
    if (!sub) return res.json({ ok: true });

    await recordPayment({
      organizationId: sub.organization_id,
      provider: 'monnify',
      reference: data.transactionReference || data.paymentReference || null,
      purpose: 'subscription',
      // Already naira. Monnify does not work in kobo.
      amount: Number(data.amountPaid || data.totalPayable || 0),
      currency: data.currencyCode || data.currency || 'NGN',
      status: succeeded ? 'success' : 'failed',
      channel: data.paymentMethod || null,
      cardBrand: details.cardType || sub.card_brand,
      cardLast4: details.last4 || sub.card_last4,
      paidAt: data.paidOn || null,
      detail: succeeded ? null : { event: type, message: data.paymentStatus || null }
    });

    if (succeeded) await rollPeriod(sub.organization_id, sub.cycle);
    else await query("UPDATE subscriptions SET status = 'past_due' WHERE id = $1", [sub.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// What the browser needs to open a payment window, decided here rather than in
// the client. Monnify's amount is fixed server-side by opening the transaction
// before the customer sees it, so a tampered-with client cannot pay ₦1 for a
// ₦5,000 plan — the reference it gets back is already bound to the real figure.
router.post('/subscription/checkout', requireOrg('admin'), async (req, res, next) => {
  try {
    const sub = await one('SELECT * FROM subscriptions WHERE organization_id = $1', [req.orgId]);
    if (!sub) return res.status(404).json({ error: 'No subscription on this organisation.' });
    if (!gateway.configured()) {
      return res.status(501).json({ error: 'Payments are not configured on this server.' });
    }

    const amount = amountFor(sub.cycle, sub.seats);
    const provider = gateway.name();

    if (provider === 'monnify') {
      const started = await monnify.initTransaction({
        amountNaira: amount,
        email: req.user.email,
        name: req.user.full_name || req.user.email,
        reference: 'profitna-' + req.orgId + '-' + Date.now(),
        description: 'Profitna subscription',
        redirectUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || undefined
      });
      return res.json({
        provider,
        amount,
        checkoutUrl: started.checkoutUrl,
        // Verification is done against Monnify's own reference.
        reference: started.transactionReference,
        paymentReference: started.paymentReference
      });
    }

    res.json({
      provider,
      amount,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY || null,
      email: req.user.email,
      reference: 'profitna-' + req.orgId + '-' + Date.now()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  chargeDue,
  activate,
  paystackWebhook,
  monnifyWebhook,
  PER_USER_MONTHLY,
  PER_USER_ANNUAL
};
