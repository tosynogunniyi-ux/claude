// One place the plan rates are written down, so the subscription API, the
// renewal charge and the owner's revenue figures cannot quietly disagree.
// Naira, per seat.

const PER_USER_MONTHLY = 5000;
const PER_USER_ANNUAL = 57000;

// How long a NEW account gets before it is asked to pay.
//
// Only new ones. Each subscription records the length it was created with in
// subscriptions.trial_days, and every read uses that in preference to this.
// Changing this number therefore changes what the next sign-up receives and
// leaves every trial already running exactly as it was promised.
//
// That is deliberate and was learned the hard way. The length used to be
// derived from this constant alone, so raising 14 to 30 reached everybody
// mid-trial — fine, since nobody minds more. Lowering it the same way would
// have locked out an account twenty days into a thirty-day trial on the night
// of the change, after telling it all week that it had ten days left.
const TRIAL_DAYS = 14;

// The length that applies to a given subscription row: what it was created
// with, or the current default for rows that predate the column.
function trialDaysFor(sub) {
  const stored = sub && sub.trial_days;
  return Number.isFinite(Number(stored)) && Number(stored) > 0 ? Number(stored) : TRIAL_DAYS;
}

function rate(cycle) {
  return cycle === 'annual' ? PER_USER_ANNUAL : PER_USER_MONTHLY;
}

function amountFor(cycle, seats) {
  return rate(cycle) * Math.max(1, Number(seats) || 1);
}

// What a subscription is worth per month, so a monthly and an annual plan can
// be added together into one recurring-revenue figure.
function monthlyValue(cycle, seats) {
  const seatCount = Math.max(1, Number(seats) || 1);
  return cycle === 'annual' ? (PER_USER_ANNUAL / 12) * seatCount : PER_USER_MONTHLY * seatCount;
}

module.exports = { PER_USER_MONTHLY, PER_USER_ANNUAL, TRIAL_DAYS, trialDaysFor, rate, amountFor, monthlyValue };
