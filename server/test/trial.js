// Does changing the constant actually move trials that already exist?
//
// Nothing in the database records when a trial ends — it is trial_start plus
// the constant, read fresh every time — so this should need no migration. That
// is a claim worth checking rather than asserting.

require('dotenv').config();
const { pool, one, query } = require('../src/db');
const access = require('../src/access');
const { TRIAL_DAYS } = require('../src/pricing');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

async function subscriptionStartedDaysAgo(tag, days, paid) {
  const org = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id', ['Trial ' + tag]);
  await query(
    `INSERT INTO subscriptions (organization_id, cycle, seats, trial_start, status, current_period_end)
     VALUES ($1, 'monthly', 1, CURRENT_DATE - $2::int, $3, $4)`,
    [org.id, days, paid ? 'active' : 'trialing', paid || null]
  );
  return one('SELECT * FROM subscriptions WHERE organization_id = $1', [org.id]);
}

(async () => {
  const t = Date.now();
  console.log('\nthe constant is what the product promises');
  check('the trial is 30 days', TRIAL_DAYS === 30, String(TRIAL_DAYS));

  console.log('\nan account that signed up today');
  const fresh = await subscriptionStartedDaysAgo('fresh-' + t, 0);
  const a = access.accessFor(fresh);
  check('is on trial', a.state === 'trial', a.state);
  check('with the full 30 days', a.daysLeft === 30, String(a.daysLeft));

  console.log('\nan account part-way through the old 14-day trial');
  // Three days in. Under the old length it had 11 left.
  const partway = await subscriptionStartedDaysAgo('partway-' + t, 3);
  const b = access.accessFor(partway);
  check('is still on trial', b.state === 'trial', b.state);
  check('and now has 27 days, not 11', b.daysLeft === 27, String(b.daysLeft));

  console.log('\nan account whose old trial had already run out');
  // Twenty days in: locked out yesterday under 14 days, inside 30 today.
  const expired = await subscriptionStartedDaysAgo('expired-' + t, 20);
  const c = access.accessFor(expired);
  check('is no longer locked out', c.state === 'trial', c.state);
  check('and has the remaining 10 days', c.daysLeft === 10, String(c.daysLeft));
  check('without anything being written to its row',
    expired.current_period_end === null && expired.status === 'trialing',
    'the extension is derived, not migrated');

  console.log('\nan account past even the new length stays shut');
  const longGone = await subscriptionStartedDaysAgo('gone-' + t, 40);
  const d = access.accessFor(longGone);
  check('is locked', d.state === 'locked', d.state);
  check('for the right reason', d.reason === 'trial_ended', d.reason);
  check('and the message states the new length',
    access.LOCKED_MESSAGE.trial_ended.includes('30-day'),
    access.LOCKED_MESSAGE.trial_ended);

  console.log('\nan account that already paid is untouched');
  // Paid up to a week from now, trial_start long past.
  const paidUntil = access.addDays(access.today(), 7);
  const payer = await subscriptionStartedDaysAgo('paid-' + t, 60, paidUntil);
  const e = access.accessFor(payer);
  check('stays active', e.state === 'active', e.state);
  check('and keeps its own term end, not a trial date',
    e.periodEnd === paidUntil, e.periodEnd + ' vs ' + paidUntil);
  check('so nobody gets free time they already paid for', e.daysLeft === 7, String(e.daysLeft));

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
