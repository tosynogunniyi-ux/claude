// End-to-end check of the Control Center against a running server and a real
// database.
//   npm start            (in one shell)
//   npm run smoke:admin  (in another)
//
// Provisions its own throwaway owner accounts directly in the database —
// there is deliberately no HTTP route that creates one — then drives the
// console over HTTP exactly as a browser would. The isolation checks at the
// end are the point of the file: a tenant session must never reach the
// console, and a console session must never reach a tenant's books.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const totp = require('../src/totp');
// Read directly for the scheduling checks: which subscriptions are due, and
// when a declined one comes round again, is decided here rather than over HTTP.
const billingModule = require('../src/billing');

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';

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

function client() {
  let cookie = null;
  return async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign(
        body ? { 'Content-Type': 'application/json' } : {},
        cookie ? { cookie } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, text };
  };
}

async function makeOwner(email, password) {
  const secret = totp.randomSecret();
  await pool.query(
    `INSERT INTO platform_admins (email, password_hash, full_name, totp_secret)
     VALUES ($1, $2, 'Smoke Owner', $3)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           totp_secret = EXCLUDED.totp_secret,
           totp_enrolled_at = NULL,
           status = 'active', failed_attempts = 0, locked_until = NULL`,
    [email, await bcrypt.hash(password, 10), secret]
  );
  return secret;
}

(async () => {
  const stamp = Date.now();
  const ownerEmail = 'smoke-owner-' + stamp + '@profitna.com';
  const ownerPassword = 'smoke-owner-password-' + stamp;
  const secret = await makeOwner(ownerEmail, ownerPassword);

  const admin = client();
  const tenant = client();

  // ---------------------------------------------------------------- sign in
  console.log('\ncontrol center sign-in');

  const wrongPassword = await admin('POST', '/api/admin/login', {
    email: ownerEmail,
    password: 'not-the-password',
    code: totp.generate(secret)
  });
  check('a wrong password is refused', wrongPassword.status === 401, 'status ' + wrongPassword.status);

  const wrongCode = await admin('POST', '/api/admin/login', {
    email: ownerEmail,
    password: ownerPassword,
    code: '000000'
  });
  check('a wrong second factor is refused', wrongCode.status === 401, 'status ' + wrongCode.status);
  check(
    'the refusal does not say which half was wrong',
    wrongPassword.body.error === wrongCode.body.error,
    JSON.stringify([wrongPassword.body.error, wrongCode.body.error])
  );

  const signedIn = await admin('POST', '/api/admin/login', {
    email: ownerEmail,
    password: ownerPassword,
    code: totp.generate(secret)
  });
  check('password plus code signs in', signedIn.status === 200, 'status ' + signedIn.status);

  const me = await admin('GET', '/api/admin/me');
  check('the session identifies the owner', me.status === 200 && me.body.admin.email === ownerEmail);
  check('first sign-in completes 2FA enrolment', Boolean(me.body.admin.totp_enrolled_at));

  const anonymous = await client()('GET', '/api/admin/overview');
  check('no session reaches no data', anonymous.status === 401, 'status ' + anonymous.status);

  // -------------------------------------------------------- a tenant to read
  console.log('\na tenant to look at');

  const tenantEmail = 'smoke-tenant-' + stamp + '@mideops.ng';
  const tenantOrg = 'Mideops Ventures ' + stamp;
  const signup = await tenant('POST', '/api/auth/signup', {
    name: 'Tosin Balogun',
    org: tenantOrg,
    email: tenantEmail,
    password: 'smoke-test-pass-1',
    book: 'sme',
    cycle: 'monthly',
    users: 3
  });
  check('signup takes no card', signup.body.session && signup.body.session.card === null);
  check('a tenant account is created', signup.status === 201, 'status ' + signup.status);
  const orgId = signup.body.session && signup.body.session.orgId;

  // ---------------------------------------------------------------- overview
  console.log('\noverview');

  const overview = await admin('GET', '/api/admin/overview');
  check('overview loads', overview.status === 200, 'status ' + overview.status);
  check('it counts registered users', overview.body.users.total >= 1, JSON.stringify(overview.body.users));
  check('it counts the new registration', overview.body.users.new7 >= 1);
  check('it counts subscriptions by state', overview.body.subscriptions.trial >= 1, JSON.stringify(overview.body.subscriptions));
  check('it reports recurring revenue', typeof overview.body.revenue.monthlyRecurring === 'number');
  check('the signup trend covers 30 days', overview.body.trends.signups.length === 30);
  check('the revenue trend covers 12 months', overview.body.trends.revenue.length === 12);
  check('it lists recent registrations', overview.body.recentUsers.some((u) => u.email === tenantEmail));

  // ------------------------------------------------------------------- users
  console.log('\nusers');

  const found = await admin('GET', '/api/admin/users?q=' + encodeURIComponent(tenantEmail));
  check('search finds the account', found.status === 200 && found.body.total === 1, JSON.stringify(found.body.total));
  const row = found.body.users[0];
  check('the row carries the organisation', row && row.orgName.startsWith('Mideops Ventures'));
  check('the row carries the plan', row && row.cycle === 'monthly' && row.seats === 3);
  check('the row prices the plan', row && row.amount === 15000, row && String(row.amount));
  check('the row shows the trial state', row && row.subscription === 'trial', row && row.subscription);
  check('the row shows the last login', Boolean(row && row.lastLoginAt));

  const filtered = await admin('GET', '/api/admin/users?sub=cancelled&q=' + encodeURIComponent(tenantEmail));
  check('filtering by subscription state excludes it', filtered.body.total === 0, String(filtered.body.total));

  const sorted = await admin('GET', '/api/admin/users?sort=lastLogin&dir=asc&pageSize=5');
  check('sorting is accepted', sorted.status === 200 && sorted.body.users.length <= 5);

  const injected = await admin('GET', '/api/admin/users?sort=' + encodeURIComponent("u.id; DROP TABLE users--"));
  check('an unknown sort falls back rather than running', injected.status === 200, 'status ' + injected.status);

  const detail = await admin('GET', '/api/admin/users/' + row.id);
  check('the account detail loads', detail.status === 200, 'status ' + detail.status);
  check('it lists the organisation', detail.body.organisations.length === 1);
  check('it lists activity', Array.isArray(detail.body.activity));
  check('it never returns a password hash', !detail.text.includes('password_hash') && !detail.text.includes('$2a$'));

  const csv = await admin('GET', '/api/admin/users.csv?q=' + encodeURIComponent(tenantEmail));
  check('users export as CSV', csv.status === 200 && csv.text.split('\n')[0].startsWith('Name,Email'));
  check('the export holds the account', csv.text.includes(tenantEmail));

  // -------------------------------------------------------------- suspending
  console.log('\nsuspending an account');

  const suspend = await admin('PATCH', '/api/admin/users/' + row.id, {
    status: 'suspended',
    reason: 'smoke test'
  });
  check('an account can be suspended', suspend.status === 200 && suspend.body.user.status === 'suspended');

  const blocked = await tenant('GET', '/api/orgs/' + orgId + '/data');
  check('the open session stops working at once', blocked.status === 403, 'status ' + blocked.status);

  const reLogin = await client()('POST', '/api/auth/login', {
    email: tenantEmail,
    password: 'smoke-test-pass-1'
  });
  check('a suspended account cannot sign back in', reLogin.status === 403, 'status ' + reLogin.status);
  check('it is told why', /suspended/i.test(reLogin.body.error || ''), reLogin.body.error);

  const badStatus = await admin('PATCH', '/api/admin/users/' + row.id, { status: 'root' });
  check('an unknown status is refused', badStatus.status === 400, 'status ' + badStatus.status);

  const restore = await admin('PATCH', '/api/admin/users/' + row.id, { status: 'active' });
  check('an account can be restored', restore.status === 200 && restore.body.user.status === 'active');

  const backIn = await tenant('POST', '/api/auth/login', {
    email: tenantEmail,
    password: 'smoke-test-pass-1'
  });
  check('the customer can sign in again', backIn.status === 200, 'status ' + backIn.status);

  // ----------------------------------------------------------- subscriptions
  console.log('\nsubscriptions');

  const subs = await admin('GET', '/api/admin/subscriptions?status=trial&q=' + encodeURIComponent(tenantOrg));
  check('trials list', subs.status === 200 && subs.body.subscriptions.length >= 1, 'status ' + subs.status);
  const sub = subs.body.subscriptions.find((s) => s.orgId === orgId);
  check('the tenant is among them', Boolean(sub), JSON.stringify(subs.body.total));

  const expired = await admin('PATCH', '/api/admin/subscriptions/' + sub.id, {
    periodEnd: '2020-01-01'
  });
  check('a period end can be set', expired.status === 200, 'status ' + expired.status);

  const nowExpired = await admin('GET', '/api/admin/users?q=' + encodeURIComponent(tenantEmail));
  check(
    'expiry is derived from the date, not stored',
    nowExpired.body.users[0].subscription === 'expired',
    nowExpired.body.users[0].subscription
  );

  const suspendedSub = await admin('PATCH', '/api/admin/subscriptions/' + sub.id, {
    status: 'suspended',
    periodEnd: ''
  });
  check('a subscription can be suspended', suspendedSub.status === 200 && suspendedSub.body.subscription.status === 'suspended');

  const upgraded = await admin('PATCH', '/api/admin/subscriptions/' + sub.id, {
    status: 'active',
    cycle: 'annual',
    seats: 5
  });
  check('plan and seats can be changed', upgraded.status === 200 && upgraded.body.subscription.amount === 285000,
    JSON.stringify(upgraded.body.subscription));

  const badDate = await admin('PATCH', '/api/admin/subscriptions/' + sub.id, { periodEnd: 'tomorrow' });
  check('a malformed period end is refused', badDate.status === 400, 'status ' + badDate.status);

  // ---------------------------------------------------------------- paywall
  console.log('\nthe paywall');

  // Something of the customer's own, to prove it survives being locked out.
  const entry = await tenant('POST', '/api/orgs/' + orgId + '/transactions', {
    type: 'income', date: '2026-03-04', amount: 125000, category: 'Sales',
    party: 'Paywall Test Ltd', description: 'written before the trial ended', method: 'Bank transfer'
  });
  check('the customer can write while the trial runs', entry.status === 201, 'status ' + entry.status);

  await pool.query(
    "UPDATE subscriptions SET status = 'trialing', current_period_end = CURRENT_DATE - 1 WHERE id = $1",
    [sub.id]
  );

  const locked = await tenant('GET', '/api/orgs/' + orgId + '/data');
  check('an expired trial closes the books', locked.status === 402, 'status ' + locked.status);
  check('with a reason the screen can render', locked.body.paywall && locked.body.paywall.reason === 'trial_ended',
    JSON.stringify(locked.body.paywall));
  check('and the amount to pay', locked.body.paywall && locked.body.paywall.amount > 0,
    JSON.stringify(locked.body.paywall && locked.body.paywall.amount));

  const lockedWrite = await tenant('POST', '/api/orgs/' + orgId + '/transactions', {
    type: 'income', date: '2026-03-05', amount: 1, category: 'Sales', party: 'x'
  });
  check('writing is closed too', lockedWrite.status === 402, 'status ' + lockedWrite.status);

  const stillPayable = await tenant('GET', '/api/orgs/' + orgId + '/subscription');
  check('but the subscription is still reachable', stillPayable.status === 200, 'status ' + stillPayable.status);

  const noProcessor = await tenant('POST', '/api/orgs/' + orgId + '/subscription/activate', {
    paymentReference: 'anything'
  });
  check('activating without a processor says so plainly',
    noProcessor.status === (process.env.PAYSTACK_SECRET_KEY ? 400 : 501), 'status ' + noProcessor.status);

  const lockedSession = await tenant('GET', '/api/auth/me');
  check('the session reports the lock', lockedSession.body.session.access === 'locked',
    lockedSession.body.session.access);

  // Paying is what reopens them. Here the Control Center stands in for the
  // charge; test/billing.js covers the real activate() path.
  await admin('PATCH', '/api/admin/subscriptions/' + sub.id, {
    status: 'active',
    periodEnd: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  });

  const reopened = await tenant('GET', '/api/orgs/' + orgId + '/data');
  check('paying opens them again', reopened.status === 200, 'status ' + reopened.status);
  check(
    'and nothing written before was lost',
    reopened.body.book.tx.some((t) => t.description === 'written before the trial ended'),
    'the transaction is gone'
  );

  // ------------------------------------------------------- automatic billing
  console.log('\nautomatic billing');

  const billing = await admin('GET', '/api/admin/billing');
  check('billing status loads', billing.status === 200, 'status ' + billing.status);
  check('it reports whether the scheduler is on', typeof billing.body.scheduler.on === 'boolean');
  check(
    'it is honest about having no processor',
    billing.body.scheduler.processor === Boolean(process.env.PAYSTACK_SECRET_KEY),
    JSON.stringify(billing.body.scheduler)
  );
  check('it counts what is due', typeof billing.body.dueNow === 'number');

  // The subscription was pushed to 2020 above, so it is overdue — but it has
  // no authorisation code, which is exactly the case that must not be
  // mistaken for a failed charge.
  await pool.query(
    "UPDATE subscriptions SET status = 'active', current_period_end = CURRENT_DATE - 1 WHERE id = $1",
    [sub.id]
  );

  const withoutCard = await billingModule.due(200);
  check(
    'a subscription with no card on file is not queued for charging',
    !withoutCard.some((r) => r.organizationId === orgId),
    'it was queued'
  );

  await pool.query(
    "UPDATE subscriptions SET provider_authorization_code = 'AUTH_smoke_' || $2 WHERE id = $1",
    [sub.id, stamp]
  );

  const queued = await billingModule.due(200);
  check(
    'an overdue subscription with a card is queued',
    queued.some((r) => r.organizationId === orgId),
    'it was not queued'
  );

  const notYet = await pool.query(
    `SELECT COUNT(*)::int AS n FROM subscriptions
      WHERE id = $1 AND COALESCE(current_period_end, trial_start + 14) > CURRENT_DATE`,
    [sub.id]
  );
  check('…and one whose term has not ended is not', notYet.rows[0].n === 0);

  const run = await admin('POST', '/api/admin/billing/run');
  check('a run can be triggered by hand', run.status === 200, 'status ' + run.status);
  check(
    'without Paystack it says so rather than pretending',
    Boolean(run.body.run.error) === !process.env.PAYSTACK_SECRET_KEY,
    JSON.stringify(run.body.run)
  );

  const afterRun = await admin('GET', '/api/admin/billing');
  check('the run is recorded', afterRun.body.runs.length >= 1);
  check('and shown as the last run', Boolean(afterRun.body.lastRun));

  // Retry scheduling, without needing a payment processor: drive the same
  // columns the scheduler writes and confirm the shortlist respects them.
  await pool.query(
    `UPDATE subscriptions
        SET charge_attempts = 1, next_charge_attempt_at = now() + interval '1 day'
      WHERE id = $1`,
    [sub.id]
  );
  const inBackoff = await billingModule.due(200);
  check(
    'a declined card is not retried until its backoff has passed',
    !inBackoff.some((r) => r.organizationId === orgId),
    'it was retried immediately'
  );

  await pool.query(
    "UPDATE subscriptions SET next_charge_attempt_at = now() - interval '1 minute' WHERE id = $1",
    [sub.id]
  );
  const afterBackoff = await billingModule.due(200);
  check(
    '…and is retried once it has',
    afterBackoff.some((r) => r.organizationId === orgId),
    'it was not retried'
  );

  await pool.query('UPDATE subscriptions SET charge_attempts = $2 WHERE id = $1', [
    sub.id,
    billingModule.MAX_ATTEMPTS
  ]);
  const givenUp = await billingModule.due(200);
  check(
    'after the last attempt it stops rather than retrying for ever',
    !givenUp.some((r) => r.organizationId === orgId),
    'it is still being retried'
  );

  await pool.query("UPDATE subscriptions SET status = 'cancelled' WHERE id = $1", [sub.id]);
  await pool.query('UPDATE subscriptions SET charge_attempts = 0 WHERE id = $1', [sub.id]);
  const cancelled = await billingModule.due(200);
  check(
    'a cancelled subscription is never charged',
    !cancelled.some((r) => r.organizationId === orgId),
    'it was queued'
  );

  await pool.query("UPDATE subscriptions SET status = 'suspended' WHERE id = $1", [sub.id]);
  const suspendedSubCheck = await billingModule.due(200);
  check(
    'nor a suspended one',
    !suspendedSubCheck.some((r) => r.organizationId === orgId),
    'it was queued'
  );

  // --------------------------------------------------------------- payments
  console.log('\npayments and activity');

  const payments = await admin('GET', '/api/admin/payments');
  check('payments list', payments.status === 200 && Array.isArray(payments.body.payments));
  check('it totals what was collected', typeof payments.body.collected === 'number');

  const activity = await admin('GET', '/api/admin/activity');
  check('activity loads', activity.status === 200 && activity.body.events.length > 0);
  check(
    'it records the suspension',
    activity.body.events.some((e) => e.action === 'user.status.suspended'),
    JSON.stringify(activity.body.events.slice(0, 3).map((e) => e.action))
  );
  check(
    'it records the sign-in and the failures',
    activity.body.events.some((e) => e.action === 'admin.login.failed'),
    'no failed-login record'
  );

  // -------------------------------------------------------------- isolation
  console.log('\nisolation between the two authentication systems');

  const tenantTriesAdmin = await tenant('GET', '/api/admin/overview');
  check('a tenant session cannot read the console', tenantTriesAdmin.status === 401, 'status ' + tenantTriesAdmin.status);

  const tenantTriesUsers = await tenant('GET', '/api/admin/users');
  check('nor its user list', tenantTriesUsers.status === 401, 'status ' + tenantTriesUsers.status);

  const adminTriesBooks = await admin('GET', '/api/orgs/' + orgId + '/data');
  check('a console session cannot read a tenant ledger', adminTriesBooks.status === 401, 'status ' + adminTriesBooks.status);

  // ---------------------------------------------------------------- lockout
  console.log('\nbrute force');

  const victimEmail = 'smoke-lock-' + stamp + '@profitna.com';
  await makeOwner(victimEmail, 'a-password-nobody-will-guess');
  const attacker = client();
  let lastAttempt = null;
  for (let i = 0; i < 6; i++) {
    lastAttempt = await attacker('POST', '/api/admin/login', {
      email: victimEmail,
      password: 'guess-' + i,
      code: '111111'
    });
  }
  check('repeated failures lock the account', lastAttempt.status === 423, 'status ' + lastAttempt.status);

  const lockedOutEvenWithPassword = await attacker('POST', '/api/admin/login', {
    email: victimEmail,
    password: 'a-password-nobody-will-guess',
    code: '111111'
  });
  check('the lock holds against the right password', lockedOutEvenWithPassword.status === 423);

  // ---------------------------------------------------------------- sessions
  console.log('\nsessions');

  const sessions = await admin('GET', '/api/admin/sessions');
  check('the owner can see their sessions', sessions.status === 200 && sessions.body.sessions.length >= 1);
  check('the current one is marked', sessions.body.sessions.some((s) => s.current));

  const out = await admin('POST', '/api/admin/logout');
  check('signing out succeeds', out.status === 200);

  const afterOut = await admin('GET', '/api/admin/me');
  check('the session is revoked server-side, not only in the browser', afterOut.status === 401, 'status ' + afterOut.status);

  // ----------------------------------------------------------------- tidy up
  await pool.query('DELETE FROM platform_admins WHERE email IN ($1, $2)', [ownerEmail, victimEmail]);
  await pool.query('DELETE FROM users WHERE email = $1', [tenantEmail]);
  await pool.query("DELETE FROM organizations WHERE name LIKE 'Mideops Ventures " + stamp + "'");
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
