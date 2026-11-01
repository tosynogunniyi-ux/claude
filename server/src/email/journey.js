// Which message is due for whom, right now.
//
// The brief said it plainly: messages must be conditional, not blindly sent
// on every listed day. That one sentence decides the architecture, so it is
// worth saying what it rules out.
//
// The obvious build is a queue: when somebody signs up, schedule the day-3
// email for three days' time. It is wrong. By day 3 the person may have
// activated, paid, been suspended, asked to hear nothing, or closed the
// account — and the queued message knows none of that. Patching it means
// chasing every queued row whenever anything changes, and the one you forget
// is the one that tells a paying customer their trial is about to expire.
//
// So nothing is queued ahead of time. The pass asks, for each organisation,
// *what is true now*, and a step is due only if its condition holds at the
// moment of sending. Somebody who activates on day 2 never receives the day-3
// email — not because something cancelled it, but because it never qualified.
// Somebody who pays on day 9 never receives the day-10 or the expiry ones for
// the same reason. That is requirement E, and it needs no mechanism at all:
// it falls out of asking the question late rather than early.
//
// Each step is a pure function of (signals, now). That is what makes the
// conditions testable without a database, a clock or a mail server — and a
// lifecycle system whose conditions cannot be tested is one that will email
// the wrong person eventually.

const { many } = require('../db');
const { trialDaysFor } = require('../pricing');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Nothing is sent about something that happened longer ago than this.
//
// Without it, switching this on would send every organisation ever created
// the step whose window it happens to sit in — a day-3 nudge to somebody who
// signed up last year. The windows below mostly prevent that on their own;
// this is the backstop that makes the first deployment safe whatever they
// say, and the reason it is a constant rather than a cleverness.
const MAX_AGE_DAYS = Number(process.env.EMAIL_MAX_EVENT_AGE_DAYS || 3);

const iso = (d) => new Date(d).toISOString();
const atDay = (from, days) => new Date(new Date(from).getTime() + days * DAY);
const dayOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// A step fires inside a window, not at an instant. The pass runs hourly and a
// container can be down for a while, so "exactly 72 hours" would be missed;
// "between 72 and 96 hours" is hit by any pass in that day. The upper bound is
// the half that matters — it is what stops a step firing months late.
const within = (now, from, to) => now >= from.getTime() && now < to.getTime();

// ------------------------------------------------------------------ signals
//
// Everything the conditions read, gathered once per organisation. Derived
// rather than stored, like the rest of this product: `activatedAt` is not a
// column somebody has to remember to set, it is the first time the business
// actually recorded anything.

const SIGNAL_SQL = `
  SELECT o.id                                           AS organization_id,
         o.name                                         AS organization_name,
         o.book_type,
         o.created_at                                   AS org_created_at,
         s.trial_start, s.trial_days, s.status, s.cycle, s.seats,
         s.current_period_end, s.current_period_start,
         s.provider_authorization_code,
         s.card_brand, s.card_last4,
         s.charge_attempts, s.last_charge_attempt_at, s.last_charge_error,
         s.suspended_at, s.cancelled_at,

         -- When this business first recorded anything real. Three tables,
         -- because a business that has only written invoices has activated
         -- just as much as one that has only recorded expenses.
         LEAST(
           (SELECT MIN(t.created_at) FROM transactions t WHERE t.organization_id = o.id),
           (SELECT MIN(i.created_at) FROM invoices i WHERE i.organization_id = o.id),
           (SELECT MIN(b.created_at) FROM bills b WHERE b.organization_id = o.id)
         )                                              AS activated_at,

         GREATEST(
           (SELECT MAX(t.created_at) FROM transactions t WHERE t.organization_id = o.id),
           (SELECT MAX(i.created_at) FROM invoices i WHERE i.organization_id = o.id),
           (SELECT MAX(b.created_at) FROM bills b WHERE b.organization_id = o.id),
           (SELECT MAX(u.last_login_at) FROM users u
              JOIN memberships m ON m.user_id = u.id
             WHERE m.organization_id = o.id)
         )                                              AS last_activity_at,

         (SELECT MIN(p.paid_at) FROM payments p
           WHERE p.organization_id = o.id AND p.status = 'success'
             AND p.purpose IN ('subscription', 'renewal'))   AS first_paid_at,

         (SELECT COUNT(*)::int FROM transactions t WHERE t.organization_id = o.id)      AS n_transactions,
         (SELECT COUNT(*)::int FROM invoices i WHERE i.organization_id = o.id)          AS n_invoices,
         (SELECT COUNT(*)::int FROM bills b WHERE b.organization_id = o.id)             AS n_bills,
         (SELECT COUNT(*)::int FROM clients c WHERE c.organization_id = o.id)           AS n_clients,
         (SELECT COUNT(*)::int FROM bank_accounts k
           WHERE k.organization_id = o.id AND k.archived_at IS NULL)                    AS n_bank_accounts,
         (SELECT COUNT(*)::int FROM customer_payments cp WHERE cp.organization_id = o.id) AS n_payments,
         (SELECT COUNT(*)::int FROM recurring_invoices r
           WHERE r.organization_id = o.id AND r.status = 'active')                      AS n_recurring,
         (SELECT COUNT(*)::int FROM inventory_items v WHERE v.organization_id = o.id)   AS n_items
    FROM organizations o
    JOIN subscriptions s ON s.organization_id = o.id`;

function shape(row) {
  const trialDays = trialDaysFor(row);
  const trialStart = row.trial_start ? new Date(row.trial_start + 'T00:00:00Z') : new Date(row.org_created_at);
  const trialEnd = new Date(trialStart.getTime() + trialDays * DAY);

  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    bookType: row.book_type,
    createdAt: new Date(row.org_created_at),

    trialStart,
    trialDays,
    trialEnd,
    status: row.status,
    cycle: row.cycle,
    seats: row.seats,
    periodEnd: row.current_period_end ? new Date(row.current_period_end + 'T00:00:00Z') : null,
    suspended: Boolean(row.suspended_at),
    cancelled: Boolean(row.cancelled_at),

    hasCard: Boolean(row.provider_authorization_code),
    card: row.card_last4 ? { brand: row.card_brand, last4: row.card_last4 } : null,
    chargeAttempts: Number(row.charge_attempts) || 0,
    lastChargeAttemptAt: row.last_charge_attempt_at ? new Date(row.last_charge_attempt_at) : null,
    lastChargeError: row.last_charge_error || null,

    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
    firstPaidAt: row.first_paid_at ? new Date(row.first_paid_at) : null,

    counts: {
      transactions: row.n_transactions, invoices: row.n_invoices, bills: row.n_bills,
      clients: row.n_clients, bankAccounts: row.n_bank_accounts,
      payments: row.n_payments, recurring: row.n_recurring, items: row.n_items
    }
  };
}

async function signalsFor(organizationId) {
  const rows = await many(SIGNAL_SQL + ' WHERE o.id = $1', [organizationId]);
  return rows.length ? shape(rows[0]) : null;
}

// Every organisation that could plausibly have something due, rather than all
// of them: one created a year ago, long since paid and settled, is not worth
// loading to decide it has nothing.
async function candidates({ limit = 500 } = {}) {
  const rows = await many(
    SIGNAL_SQL + `
     WHERE o.created_at > now() - ($1 || ' days')::interval
        OR s.status IN ('trialing', 'past_due')
        OR s.last_charge_attempt_at > now() - ($1 || ' days')::interval
        OR s.current_period_start > now() - ($1 || ' days')::interval
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [String(Math.max(MAX_AGE_DAYS, 14)), limit]
  );
  return rows.map(shape);
}

// ----------------------------------------------------------------- the steps
//
// Each returns null, or the message that is due. The `when` of each is the
// condition in full — there is no "and also check X" anywhere else, because a
// condition split across two files is a condition that will be half-changed.

// Is this business actually using Profitna for anything?
const activated = (s) => s.activatedAt !== null;

// Did money arrive and get confirmed? Not "did they click pay" — the
// subscription being active with a payment behind it.
const paying = (s) => s.firstPaidAt !== null && (s.status === 'active' || s.status === 'past_due');

const onTrial = (s) => s.status === 'trialing' && !s.suspended;

// The feature worth mentioning to this particular business, chosen from what
// they have not reached yet. This is what makes step 4 guidance rather than a
// newsletter: a business already raising invoices is not told about raising
// invoices.
function nextUsefulFeature(s) {
  const c = s.counts;
  if (c.bankAccounts === 0) {
    return { key: 'bank', title: 'Add your bank account',
      body: 'Every figure in your reports comes from money moving. Adding the account it moves through means your balances are real rather than a running total.' };
  }
  if (c.invoices === 0 && s.bookType !== 'church') {
    return { key: 'invoices', title: 'Send your first invoice',
      body: 'Profitna numbers it, works out the VAT and withholding, produces the PDF, and posts it to your books — so the invoice and the accounts cannot disagree.' };
  }
  if (c.invoices > 0 && c.payments === 0) {
    return { key: 'payments', title: 'Record a payment against an invoice',
      body: 'One payment can settle several invoices at once, and whatever is left over sits on the customer’s account instead of being forced onto one.' };
  }
  if (c.invoices > 2 && c.recurring === 0) {
    return { key: 'recurring', title: 'Let a repeating invoice raise itself',
      body: 'A retainer billed on the same day every month is the same invoice twelve times. Set it up once and Profitna raises each one on the day.' };
  }
  if (c.transactions > 10 && c.bills === 0) {
    return { key: 'bills', title: 'Track what you owe, not just what you spend',
      body: 'Recording a bill when it arrives rather than when you pay it is what makes your profit figure the real one.' };
  }
  return { key: 'reports', title: 'Your reports are already written',
    body: 'Profit and loss, balance sheet, trial balance and a VAT summary — all built from what you have already recorded. Nothing to prepare.' };
}

// The ordered list. Order matters only for readability; each condition stands
// alone and more than one can be due in the same pass.
const STEPS = [
  // A — registration. The only unconditional one, and it is still bounded:
  // an organisation created before this system existed does not get a
  // welcome email months late.
  {
    kind: 'welcome',
    category: 'transactional',
    when: (s, now) => within(now, s.createdAt, atDay(s.createdAt, MAX_AGE_DAYS)),
    key: () => 'once'
  },

  // B — 24 hours of inactivity. "Inactive" means nothing has been recorded,
  // not that they have not logged in: somebody who signed in twice and
  // recorded nothing is exactly who this is for.
  {
    kind: 'setup_help',
    category: 'onboarding',
    when: (s, now) => !activated(s) && !paying(s) &&
      within(now, atDay(s.createdAt, 1), atDay(s.createdAt, 2)),
    key: () => 'once'
  },

  // C — day 3 without activation. Not sent if they activated yesterday, not
  // sent if they have already paid, and not sent on day 30 to somebody who
  // never came back.
  {
    kind: 'activation_offer',
    category: 'onboarding',
    when: (s, now) => !activated(s) && onTrial(s) &&
      within(now, atDay(s.createdAt, 3), atDay(s.createdAt, 4)),
    key: () => 'once'
  },

  // D — six days after activation, which is six days after *they started
  // using it*, not six days after signing up. Somebody who activates on day
  // 12 gets this on day 18.
  {
    kind: 'feature_guidance',
    category: 'onboarding',
    when: (s, now) => activated(s) && !s.suspended &&
      within(now, atDay(s.activatedAt, 6), atDay(s.activatedAt, 7)),
    key: (s) => nextUsefulFeature(s).key,
    data: (s) => ({ feature: nextUsefulFeature(s) })
  },

  // E — day 10, still on trial, no card. Skipped entirely for anybody who
  // has already arranged payment.
  {
    kind: 'trial_status',
    category: 'transactional',
    when: (s, now) => onTrial(s) && !s.hasCard && !paying(s) &&
      now < s.trialEnd.getTime() &&
      within(now, atDay(s.createdAt, 10), atDay(s.createdAt, 11)),
    key: () => 'once'
  },

  // F — 48 hours before the real expiry date. The date is this
  // subscription's own: trial_start plus the trial_days recorded on it, not
  // today's default, because the default has changed twice and the promise
  // made to each account was the one in force when they signed up.
  //
  // Keyed by the date, so extending a trial produces a fresh reminder rather
  // than being silently suppressed by the one already sent.
  {
    kind: 'trial_ending',
    category: 'transactional',
    when: (s, now) => onTrial(s) && !paying(s) &&
      within(now, new Date(s.trialEnd.getTime() - 2 * DAY), s.trialEnd),
    key: (s) => dayOnly(s.trialEnd)
  },

  // G — at expiry. Their access has just changed, which is the clearest case
  // there is for a message about the account.
  {
    kind: 'trial_ended',
    category: 'transactional',
    when: (s, now) => onTrial(s) && !paying(s) &&
      within(now, s.trialEnd, atDay(s.trialEnd, MAX_AGE_DAYS)),
    key: (s) => dayOnly(s.trialEnd)
  },

  // H — after a confirmed payment. Confirmed means the processor said so and
  // a payment row exists; not that somebody reached a success page.
  {
    kind: 'paid_welcome',
    category: 'transactional',
    when: (s, now) => paying(s) &&
      within(now, s.firstPaidAt, atDay(s.firstPaidAt, MAX_AGE_DAYS)),
    key: () => 'once'
  },

  // The paid journey's second step: a week in, once they have had time to
  // use what they paid for.
  {
    kind: 'paid_settling_in',
    category: 'onboarding',
    when: (s, now) => paying(s) && !s.suspended &&
      within(now, atDay(s.firstPaidAt, 7), atDay(s.firstPaidAt, 8)),
    key: () => 'once',
    data: (s) => ({ feature: nextUsefulFeature(s) })
  },

  // D (payment failure). One per attempt, so each retry in the backoff is
  // reported once and the fourth does not re-send the first.
  {
    kind: 'payment_failed',
    category: 'transactional',
    when: (s, now) => s.chargeAttempts > 0 && s.lastChargeError && s.lastChargeAttemptAt &&
      s.status !== 'active' &&
      within(now, s.lastChargeAttemptAt, atDay(s.lastChargeAttemptAt, MAX_AGE_DAYS)),
    key: (s) => 'attempt-' + s.chargeAttempts
  },

  // And the end of the retries, which is a different message: not "we will
  // try again" but "we have stopped trying".
  {
    kind: 'payment_past_due',
    category: 'transactional',
    when: (s, now) => s.status === 'past_due' && s.lastChargeAttemptAt &&
      within(now, s.lastChargeAttemptAt, atDay(s.lastChargeAttemptAt, MAX_AGE_DAYS)),
    key: (s) => dayOnly(s.periodEnd || s.lastChargeAttemptAt)
  }
];

const BY_KIND = {};
for (const step of STEPS) BY_KIND[step.kind] = step;

// Everything due for one organisation at one moment. The whole conditional
// system is this function; nothing decides to send anywhere else.
function due(signals, at) {
  const now = (at ? new Date(at) : new Date()).getTime();
  const out = [];
  for (const step of STEPS) {
    let qualifies = false;
    try {
      qualifies = Boolean(step.when(signals, now));
    } catch {
      // A signal that is not the shape this condition expected means the
      // condition cannot be evaluated, which is not the same as being due.
      qualifies = false;
    }
    if (!qualifies) continue;
    out.push({
      kind: step.kind,
      category: step.category,
      dedupeKey: String(step.key ? step.key(signals) : 'once'),
      data: step.data ? step.data(signals) : {}
    });
  }
  return out;
}

// Why a given step is or is not due, for one organisation. Not used by the
// sender — this is for the question "why did my customer not get that
// email", which is otherwise answered by reading code and guessing.
function explain(signals, at) {
  const now = (at ? new Date(at) : new Date()).getTime();
  return STEPS.map((step) => {
    let qualifies = false;
    let error = null;
    try { qualifies = Boolean(step.when(signals, now)); } catch (err) { error = err.message; }
    return {
      kind: step.kind,
      category: step.category,
      due: qualifies,
      dedupeKey: qualifies && step.key ? String(step.key(signals)) : null,
      error
    };
  });
}

module.exports = {
  STEPS, BY_KIND, due, explain, signalsFor, candidates, shape,
  nextUsefulFeature, activated, paying, onTrial,
  MAX_AGE_DAYS, DAY, HOUR, SIGNAL_SQL
};
