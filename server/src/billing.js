const { one, many, query, pool } = require('./db');
const { chargeDue } = require('./routes/subscription');
const paystack = require('./integrations/paystack');
const { TRIAL_DAYS } = require('./pricing');

// The thing that makes a trial end. chargeDue() charges one organisation;
// this decides which organisations are due, retries the ones whose card was
// declined on a schedule rather than on every tick, and records each run so
// the owner can see in the Control Center whether billing is happening at all.

// Four attempts spread over a fortnight, then it stops and leaves the
// subscription past_due for a human to look at. Cancelling someone's books
// because a card expired is a decision for the owner, not for a timer.
const RETRY_DAYS = [1, 3, 5, 7];
const MAX_ATTEMPTS = RETRY_DAYS.length;

// Never charge more than this in one pass. A backlog after downtime should
// drain over several runs rather than firing hundreds of charges at once.
const BATCH = Number(process.env.BILLING_BATCH) || 50;

// One arbitrary but fixed number. Two containers running the same image would
// otherwise both wake up and charge the same card.
const LOCK_KEY = 4820771;

function intervalMs() {
  const minutes = Number(process.env.BILLING_INTERVAL_MINUTES) || 60;
  return Math.max(1, minutes) * 60 * 1000;
}

function enabled() {
  return process.env.BILLING_SCHEDULER !== 'off';
}

// A term that has run out, on a subscription still meant to be billed, whose
// retry window (if it is in one) has come round.
const DUE_SQL = `
  SELECT s.organization_id AS "organizationId",
         s.id,
         s.status,
         s.cycle,
         s.seats,
         s.charge_attempts AS attempts,
         COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS}) AS "dueOn",
         o.name AS "orgName"
    FROM subscriptions s
    JOIN organizations o ON o.id = s.organization_id
   WHERE s.status IN ('trialing', 'active', 'past_due')
     AND s.provider_authorization_code IS NOT NULL
     AND COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS}) <= CURRENT_DATE
     AND (
           s.charge_attempts = 0
           OR (s.charge_attempts < ${MAX_ATTEMPTS} AND s.next_charge_attempt_at <= now())
         )
   ORDER BY COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS})`;

function due(limit) {
  return many(DUE_SQL + ' LIMIT $1', [limit || BATCH]);
}

// Everything waiting, including the ones sitting out a retry window — what
// the console shows, as opposed to what this pass will attempt.
function outstanding() {
  return many(
    `SELECT s.organization_id AS "organizationId", s.charge_attempts AS attempts,
            s.last_charge_error AS "lastError", s.next_charge_attempt_at AS "nextAttempt",
            COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS}) AS "dueOn",
            o.name AS "orgName"
       FROM subscriptions s
       JOIN organizations o ON o.id = s.organization_id
      WHERE s.status IN ('trialing', 'active', 'past_due')
        AND COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS}) <= CURRENT_DATE
        AND s.provider_authorization_code IS NOT NULL
      ORDER BY COALESCE(s.current_period_end, s.trial_start + ${TRIAL_DAYS})
      LIMIT 25`
  );
}

async function markCharged(organizationId) {
  await query(
    `UPDATE subscriptions
        SET charge_attempts = 0, last_charge_attempt_at = now(),
            next_charge_attempt_at = NULL, last_charge_error = NULL
      WHERE organization_id = $1`,
    [organizationId]
  );
}

async function markFailed(organizationId, attempts, reason) {
  const nextIn = RETRY_DAYS[Math.min(attempts, RETRY_DAYS.length - 1)];
  await query(
    `UPDATE subscriptions
        SET charge_attempts = $2, last_charge_attempt_at = now(),
            next_charge_attempt_at = now() + ($3 || ' days')::interval,
            last_charge_error = $4
      WHERE organization_id = $1`,
    [organizationId, attempts + 1, String(nextIn), String(reason || '').slice(0, 500)]
  );
}

// -------------------------------------------------------------------------
// A run
// -------------------------------------------------------------------------

async function runOnce(trigger) {
  const run = await one(
    "INSERT INTO billing_runs (trigger) VALUES ($1) RETURNING id, started_at",
    [trigger === 'manual' ? 'manual' : 'schedule']
  );

  const totals = { considered: 0, charged: 0, failed: 0, amount: 0, skipped: 0, error: null };

  // Held for the whole pass on one connection: if another container is
  // already billing, this one does nothing rather than charging in parallel.
  const client = await pool.connect();
  let holdsLock = false;
  try {
    holdsLock = (await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY])).rows[0].got;
    if (!holdsLock) {
      totals.error = 'another instance is already running a billing pass';
    } else if (!paystack.configured()) {
      totals.error = 'PAYSTACK_SECRET_KEY is not set — nothing can be charged';
    } else {
      const rows = await due();
      totals.considered = rows.length;

      for (const row of rows) {
        let result;
        try {
          result = await chargeDue(row.organizationId);
        } catch (err) {
          result = { charged: false, reason: err.message };
        }

        if (result.charged) {
          totals.charged++;
          totals.amount += Number(result.amount) || 0;
          await markCharged(row.organizationId);
          console.log('billing: charged ' + row.orgName + ' ' + (result.amount || 0));
        } else if (result.reason === 'not billable' || result.reason === 'no card on file') {
          // Nothing was attempted and nothing will change by trying again in
          // an hour, so this is not a failed charge — just not our business.
          totals.skipped++;
        } else {
          totals.failed++;
          await markFailed(row.organizationId, row.attempts, result.reason);
          console.log('billing: failed for ' + row.orgName + ' — ' + result.reason);
        }
      }
    }
  } catch (err) {
    totals.error = err.message;
    console.error('billing: run failed — ' + err.message);
  } finally {
    if (holdsLock) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }

  await query(
    `UPDATE billing_runs
        SET finished_at = now(), considered = $2, charged = $3, failed = $4, amount = $5, error = $6
      WHERE id = $1`,
    [run.id, totals.considered, totals.charged, totals.failed, totals.amount, totals.error]
  );

  return Object.assign({ id: run.id, startedAt: run.started_at }, totals);
}

// -------------------------------------------------------------------------
// The timer
// -------------------------------------------------------------------------

let timer = null;

function start() {
  if (!enabled()) {
    console.log('billing scheduler is off (BILLING_SCHEDULER=off)');
    return null;
  }
  if (timer) return timer;

  const every = intervalMs();
  console.log(
    'billing scheduler on: every ' + Math.round(every / 60000) + ' minutes' +
    (paystack.configured() ? '' : ' (idle — PAYSTACK_SECRET_KEY is not set)')
  );

  // Not immediately: a container that restart-loops should not start a
  // billing pass on each boot.
  const first = setTimeout(function tick() {
    runOnce('schedule').catch((err) => console.error('billing: ' + err.message));
    timer = setInterval(() => {
      runOnce('schedule').catch((err) => console.error('billing: ' + err.message));
    }, every);
  }, 2 * 60 * 1000);

  first.unref();
  return first;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function lastRun() {
  return one(
    `SELECT id, trigger, started_at AS "startedAt", finished_at AS "finishedAt",
            considered, charged, failed, amount, error
       FROM billing_runs ORDER BY started_at DESC LIMIT 1`
  );
}

module.exports = {
  start,
  stop,
  runOnce,
  due,
  outstanding,
  lastRun,
  enabled,
  intervalMs,
  MAX_ATTEMPTS,
  RETRY_DAYS
};
