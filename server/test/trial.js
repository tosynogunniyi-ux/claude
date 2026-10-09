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

async function subscriptionStartedDaysAgo(tag, days, paid, trialDays) {
  const org = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id', ['Trial ' + tag]);
  await query(
    `INSERT INTO subscriptions (organization_id, cycle, seats, trial_start, status, current_period_end, trial_days)
     VALUES ($1, 'monthly', 1, CURRENT_DATE - $2::int, $3, $4, $5)`,
    [org.id, days, paid ? 'active' : 'trialing', paid || null,
     trialDays === undefined ? TRIAL_DAYS : trialDays]
  );
  return one('SELECT * FROM subscriptions WHERE organization_id = $1', [org.id]);
}

(async () => {
  const t = Date.now();
  console.log('\nthe default for a new sign-up');
  check('is 14 days', TRIAL_DAYS === 14, String(TRIAL_DAYS));

  console.log('\nan account that signed up today');
  const fresh = await subscriptionStartedDaysAgo('fresh-' + t, 0);
  const a = access.accessFor(fresh);
  check('is on trial', a.state === 'trial', a.state);
  check('with the full 14 days', a.daysLeft === 14, String(a.daysLeft));
  check('and records the length it was given', fresh.trial_days === 14, String(fresh.trial_days));

  console.log('\nan account already running on the longer trial');
  // Twenty days into a thirty-day trial. Under the new default it would have
  // been locked out six days ago — this is the whole point of storing it.
  const legacy = await subscriptionStartedDaysAgo('legacy-' + t, 20, null, 30);
  const b = access.accessFor(legacy);
  check('keeps the length it was promised', b.trialDays === 30, String(b.trialDays));
  check('is still on trial', b.state === 'trial', b.state);
  check('with its remaining 10 days intact', b.daysLeft === 10, String(b.daysLeft));
  check('rather than being locked out by the change',
    b.state !== 'locked',
    'shortening the default must never shut an account that is mid-trial');

  console.log('\na row from before the column existed');
  const old = await subscriptionStartedDaysAgo('nulldays-' + t, 3, null, null);
  const c = access.accessFor(old);
  check('falls back to the current default', c.trialDays === 14, String(c.trialDays));
  check('and still works out', c.state === 'trial' && c.daysLeft === 11, JSON.stringify(c.daysLeft));

  console.log('\nan account past its own length stays shut');
  const longGone = await subscriptionStartedDaysAgo('gone-' + t, 40, null, 30);
  const d = access.accessFor(longGone);
  check('is locked', d.state === 'locked', d.state);
  check('for the right reason', d.reason === 'trial_ended', d.reason);
  check('and the message does not quote a length that may not be theirs',
    !/\d+-day/.test(access.LOCKED_MESSAGE.trial_ended),
    access.LOCKED_MESSAGE.trial_ended);

  console.log('\nan account that already paid is untouched');
  // Paid up to a week from now, trial_start long past.
  const paidUntil = access.addDays(access.today(), 7);
  const payer = await subscriptionStartedDaysAgo('paid-' + t, 60, paidUntil, 30);
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
