// Does a trial actually end?
//   npm run test:billing
//
// Runs in process, against the real database, with the payment processor
// stubbed — the one part of this path that cannot be exercised for real
// without charging somebody's card. Everything else is the shipping code:
// the same shortlist the scheduler uses, the same chargeDue(), the same
// period roll, payment row, audit entry and retry bookkeeping.

require('dotenv').config();
const { pool, one, query } = require('../src/db');
const paystack = require('../src/integrations/paystack');
const billing = require('../src/billing');
const subscription = require('../src/routes/subscription');
const access = require('../src/access');
const { PER_USER_MONTHLY } = require('../src/pricing');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

// The stub. `outcome` is flipped between charges to exercise both branches.
let outcome = { ok: true, body: { data: { status: 'success' } } };
paystack.configured = () => true;
paystack.chargeAuthorization = async () => outcome;

async function makeSubscription(stamp, trialStartedDaysAgo) {
  const org = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
    'Billing Test ' + stamp
  ]);
  const user = await one(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'Billing Test') RETURNING id`,
    ['billing-test-' + stamp + '@example.ng']
  );
  await query("INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')", [
    user.id,
    org.id
  ]);
  await query(
    `INSERT INTO subscriptions (organization_id, cycle, seats, trial_start, provider,
                                provider_authorization_code, card_brand, card_last4)
     VALUES ($1, 'monthly', 2, CURRENT_DATE - $2::int, 'paystack', $3, 'Visa', '4081')`,
    [org.id, trialStartedDaysAgo, 'AUTH_test_' + stamp]
  );
  return { orgId: org.id, userId: user.id };
}

function subscriptionFor(orgId) {
  return one('SELECT * FROM subscriptions WHERE organization_id = $1', [orgId]);
}

(async () => {
  const stamp = Date.now();

  // A trial that started 14 days ago is over today; one that started 13 days
  // ago still has a day to run.
  const over = await makeSubscription(stamp, 14);
  const running = await makeSubscription(stamp + 1, 13);

  console.log('\nwhat is due');
  const shortlist = await billing.due(500);
  check(
    'a trial that has run out is due',
    shortlist.some((r) => r.organizationId === over.orgId),
    'it was not on the list'
  );
  check(
    'a trial with a day left is not',
    !shortlist.some((r) => r.organizationId === running.orgId),
    'it was on the list'
  );

  console.log('\na charge that succeeds');
  outcome = { ok: true, body: { data: { status: 'success' } } };
  const good = await billing.runOnce('manual');
  check('the run reports what it charged', good.charged >= 1, JSON.stringify(good));
  check('and no failures', good.failed === 0, JSON.stringify(good));

  const charged = await subscriptionFor(over.orgId);
  check('the trial becomes an active subscription', charged.status === 'active', charged.status);
  check('the term starts today', charged.current_period_start === new Date().toISOString().slice(0, 10),
    String(charged.current_period_start));
  check(
    'and ends a month out',
    charged.current_period_end ===
      new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString().slice(0, 10),
    String(charged.current_period_end)
  );
  check('the attempt counter is clear', charged.charge_attempts === 0);

  const payment = await one(
    "SELECT * FROM payments WHERE organization_id = $1 AND purpose = 'renewal' ORDER BY created_at DESC LIMIT 1",
    [over.orgId]
  );
  check('the charge is in the payment history', Boolean(payment));
  check('for the right amount', payment && Number(payment.amount) === PER_USER_MONTHLY * 2,
    payment && String(payment.amount));
  check('marked successful', payment && payment.status === 'success');

  const entry = await one(
    "SELECT * FROM audit_log WHERE organization_id = $1 AND action = 'subscription.charged'",
    [over.orgId]
  );
  check('and in the activity log', Boolean(entry));

  const settled = await billing.due(500);
  check(
    'a subscription just charged is no longer due',
    !settled.some((r) => r.organizationId === over.orgId),
    'it would be charged twice'
  );

  console.log('\na charge that is declined');
  await query(
    "UPDATE subscriptions SET current_period_end = CURRENT_DATE - 1 WHERE organization_id = $1",
    [over.orgId]
  );
  outcome = { ok: false, body: { message: 'Insufficient funds' } };
  const bad = await billing.runOnce('manual');
  check('the run reports the failure', bad.failed >= 1, JSON.stringify(bad));

  const declined = await subscriptionFor(over.orgId);
  check('the subscription goes past due', declined.status === 'past_due', declined.status);
  check('the attempt is counted', declined.charge_attempts === 1, String(declined.charge_attempts));
  check('the reason is kept', declined.last_charge_error === 'Insufficient funds', declined.last_charge_error);
  check('a retry is scheduled', Boolean(declined.next_charge_attempt_at));
  check(
    'a day out, not immediately',
    new Date(declined.next_charge_attempt_at) - Date.now() > 20 * 60 * 60 * 1000,
    String(declined.next_charge_attempt_at)
  );

  const failedPayment = await one(
    "SELECT * FROM payments WHERE organization_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
    [over.orgId]
  );
  check('the declined charge is in the history too', Boolean(failedPayment));
  check(
    'with the reason the processor gave',
    failedPayment && failedPayment.detail && failedPayment.detail.message === 'Insufficient funds',
    failedPayment && JSON.stringify(failedPayment.detail)
  );

  const immediately = await billing.runOnce('manual');
  check(
    'the next run does not retry it straight away',
    !(await billing.due(500)).some((r) => r.organizationId === over.orgId) && immediately.failed === 0,
    JSON.stringify(immediately)
  );

  console.log('\nrecovering');
  await query(
    "UPDATE subscriptions SET next_charge_attempt_at = now() - interval '1 minute' WHERE organization_id = $1",
    [over.orgId]
  );
  outcome = { ok: true, body: { data: { status: 'success' } } };
  const recovered = await billing.runOnce('manual');
  check('a later attempt goes through', recovered.charged >= 1, JSON.stringify(recovered));

  const settledAgain = await subscriptionFor(over.orgId);
  check('the subscription is active again', settledAgain.status === 'active', settledAgain.status);
  check('and the failure is forgotten', settledAgain.charge_attempts === 0 && !settledAgain.last_charge_error);

  console.log('\npaying at the end of the trial');

  // A fresh account, exactly as signup leaves it: trial over, no card, no
  // authorisation code — nothing the biller can charge.
  const unpaid = await makeSubscription(stamp + 2, 20);
  await query(
    'UPDATE subscriptions SET provider_authorization_code = NULL, card_brand = NULL, card_last4 = NULL WHERE organization_id = $1',
    [unpaid.orgId]
  );

  const before = await subscriptionFor(unpaid.orgId);
  check('it starts locked out', access.accessFor(before).state === 'locked', access.accessFor(before).state);
  check('for the right reason', access.accessFor(before).reason === 'trial_ended', access.accessFor(before).reason);
  check(
    'and the scheduler leaves it alone — there is nothing to charge',
    !(await billing.due(500)).some((r) => r.organizationId === unpaid.orgId),
    'it was queued for a charge with no card'
  );

  const price = PER_USER_MONTHLY * 2;
  const verified = (amount) => async (reference) => ({
    provider: 'paystack', customerId: 'CUS_test', authorizationCode: 'AUTH_paid_' + stamp,
    reference, amount, currency: 'NGN', channel: 'card', paidAt: new Date().toISOString(),
    card: { brand: 'Visa', last4: '4081', exp: '09/29' }
  });

  paystack.verify = async () => null;
  const unverified = await subscription.activate(unpaid.orgId, { reference: 'made-up', email: 'x@example.ng' });
  check('a reference Paystack does not recognise is refused', unverified.ok === false, JSON.stringify(unverified));

  // The amount is read from Paystack, never from the browser, so paying less
  // than the plan costs cannot open the books.
  paystack.verify = verified(price - 1000);
  const short = await subscription.activate(unpaid.orgId, { reference: 'ref-short', email: 'x@example.ng' });
  check('a payment short of the plan price is refused', short.ok === false, JSON.stringify(short));
  check('and the books stay shut',
    access.accessFor(await subscriptionFor(unpaid.orgId)).state === 'locked');

  paystack.verify = verified(price);
  const paid = await subscription.activate(unpaid.orgId, {
    reference: 'ref-' + stamp,
    email: 'billing-test-' + (stamp + 2) + '@example.ng'
  });
  check('a verified payment activates the subscription', paid.ok === true, JSON.stringify(paid));

  const after = await subscriptionFor(unpaid.orgId);
  check('the books open again', access.accessFor(after).state === 'active', access.accessFor(after).state);
  check('the term starts today', after.current_period_start === new Date().toISOString().slice(0, 10));
  check('the card is now on file', after.card_last4 === '4081', String(after.card_last4));
  check('with a reusable authorisation for the next renewal',
    after.provider_authorization_code === 'AUTH_paid_' + stamp, after.provider_authorization_code);

  const activationPayment = await one(
    "SELECT * FROM payments WHERE organization_id = $1 AND status = 'success' ORDER BY created_at DESC LIMIT 1",
    [unpaid.orgId]
  );
  check('the payment is in the history', Boolean(activationPayment) && Number(activationPayment.amount) === price,
    activationPayment && String(activationPayment.amount));

  const activationEntry = await one(
    "SELECT * FROM audit_log WHERE organization_id = $1 AND action = 'subscription.activated'",
    [unpaid.orgId]
  );
  check('and in the activity log', Boolean(activationEntry));

  const renewable = await billing.due(500);
  check(
    'the renewal is now the scheduler’s job, not today’s',
    !renewable.some((r) => r.organizationId === unpaid.orgId),
    'it is due again immediately'
  );

  console.log('\nthe run log');
  const last = await billing.lastRun();
  check('every pass is recorded', Boolean(last) && Boolean(last.finishedAt));
  check('with what it charged', Number(last.amount) === PER_USER_MONTHLY * 2, String(last.amount));

  // ----------------------------------------------------------------- tidy up
  for (const id of [over.orgId, running.orgId, unpaid.orgId]) {
    await query('DELETE FROM organizations WHERE id = $1', [id]);
  }
  await query('DELETE FROM users WHERE email LIKE $1', ['billing-test-%@example.ng']);
  await query("DELETE FROM billing_runs WHERE started_at > now() - interval '10 minutes'");
  await pool.end();

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
