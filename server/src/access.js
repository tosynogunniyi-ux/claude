const { one } = require('./db');
const { TRIAL_DAYS, amountFor } = require('./pricing');

// Who may use the books, and until when.
//
// Signing up costs nothing and asks for no card: an account starts on a
// 14-day trial and is fully usable. When the trial runs out — or a paid term
// lapses — the books stop opening until a subscription is paid for. Nothing
// is deleted; the data sits where it was and comes back the moment payment
// goes through.
//
// Like document status and subscription expiry, this is **derived** at read
// time from the dates. A stored "locked" flag would be correct only until the
// next midnight nothing ran through.

function today() {
  const d = new Date();
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso + 'T00:00:00Z') - new Date(fromIso + 'T00:00:00Z')) / 86400000);
}

// `sub` is a row from subscriptions. Dates arrive as 'YYYY-MM-DD' strings, so
// this is plain string comparison and never shifts across a timezone.
function accessFor(sub) {
  if (!sub) {
    return { state: 'locked', reason: 'no_subscription', daysLeft: 0, trialEndsOn: null, periodEnd: null, amount: 0 };
  }

  const now = today();
  const trialEndsOn = addDays(sub.trial_start, TRIAL_DAYS);
  // A subscription that has never been charged runs to the end of its trial.
  const periodEnd = sub.current_period_end || trialEndsOn;
  const onTrial = sub.status === 'trialing';
  const amount = amountFor(sub.cycle, sub.seats);

  let state;
  let reason = null;
  if (sub.status === 'suspended') {
    state = 'locked';
    reason = 'suspended';
  } else if (periodEnd < now) {
    state = 'locked';
    reason = onTrial ? 'trial_ended' : 'subscription_lapsed';
  } else {
    state = onTrial ? 'trial' : 'active';
  }

  return {
    state,
    reason,
    onTrial,
    // 0 means "ends today", and access continues through today.
    daysLeft: Math.max(0, daysBetween(now, periodEnd)),
    trialEndsOn,
    periodEnd,
    cycle: sub.cycle,
    seats: sub.seats,
    amount,
    cardOnFile: Boolean(sub.card_last4)
  };
}

const LOCKED_MESSAGE = {
  trial_ended: 'Your 14-day free trial has ended. Activate your subscription to continue.',
  subscription_lapsed: 'Your subscription is not active. Complete payment to continue.',
  suspended: 'This account is suspended. Contact support@profitna.com.',
  no_subscription: 'This organisation has no subscription.'
};

// Mounted in front of the book itself, and never in front of the subscription
// routes — an account that cannot pay its way in still has to be able to pay.
async function requireSubscription(req, res, next) {
  try {
    const orgId = req.params.orgId;
    // Not a real id, or not this caller's organisation: let requireOrg decide,
    // so a stranger gets the same 404 either way rather than learning from a
    // 402 that the organisation exists.
    if (!/^[0-9a-f-]{36}$/i.test(orgId || '')) return next();

    const sub = await one(
      `SELECT s.* FROM memberships m
         JOIN subscriptions s ON s.organization_id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2`,
      [req.user.id, orgId]
    );
    if (!sub) return next();

    const access = accessFor(sub);
    if (access.state !== 'locked') {
      req.access = access;
      return next();
    }

    // 402 is the one status that means exactly this. The body carries what the
    // paywall needs to render itself, so the client does not have to guess.
    res.status(402).json({
      error: LOCKED_MESSAGE[access.reason] || LOCKED_MESSAGE.subscription_lapsed,
      paywall: access
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { accessFor, requireSubscription, addDays, today, LOCKED_MESSAGE };
