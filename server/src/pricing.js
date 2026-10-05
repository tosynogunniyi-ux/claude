// One place the plan rates are written down, so the subscription API, the
// renewal charge and the owner's revenue figures cannot quietly disagree.
// Naira, per seat.

const PER_USER_MONTHLY = 5000;
const PER_USER_ANNUAL = 57000;

// How long a new account has before it is asked to pay.
//
// Changing this moves every trial, not just the ones started afterwards. When
// a trial ends is derived — trial_start plus this number — and never written
// into a row, so an account three days into a 14-day trial simply finds it has
// 27 days left. Accounts that have already paid carry a real
// current_period_end and are untouched by it.
const TRIAL_DAYS = 30;

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

module.exports = { PER_USER_MONTHLY, PER_USER_ANNUAL, TRIAL_DAYS, rate, amountFor, monthlyValue };
