// The pass that runs on its own.
//
// Same shape as every other scheduled thing in this product — billing,
// backups, the ledger backfill, recurring invoices — because the properties
// wanted are the same ones, and a fifth way of doing it would be a fifth
// thing to get wrong.
//
//   Under a Postgres advisory lock, so more than one container does not both
//   decide that the same trial is ending.
//
//   Idempotent at the row level regardless, because the lock is an
//   optimisation and the unique index is the guarantee.
//
//   Batched and interruptible: a container that dies halfway has sent what it
//   sent, recorded what it recorded, and the next pass continues.
//
//   Off by default. EMAIL_SENDING must be switched on deliberately, and until
//   it is, the pass still runs and still records — so the outbox fills with
//   exactly what would have gone out and can be read before a single customer
//   hears anything.

const { pool } = require('../db');
const outbox = require('./outbox');
const provider = require('./provider');
const journey = require('./journey');
const consent = require('./consent');

// billing 4820771, backups 4820772, ledger 4820773, recurring 4820774
const LOCK_KEY = 4820775;
const INTERVAL_MS = Number(process.env.EMAIL_INTERVAL_MS || 15 * 60 * 1000);

const enabled = () => String(process.env.EMAIL_SCHEDULER || 'on').toLowerCase() !== 'off';

let last = null;

async function run(options = {}) {
  const started = Date.now();
  const decided = await outbox.evaluate(options);
  const sent = await outbox.flush({ limit: options.sendLimit });
  const result = {
    at: new Date().toISOString(),
    decided,
    sent,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  last = result;
  return result;
}

async function runOnce(options) {
  if (!enabled()) return null;
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0].ok) return null;
    try {
      return await run(options || {});
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Every fifteen minutes, and once shortly after boot. Fifteen rather than
// hourly because the two time-sensitive ones — a card failing, a trial
// ending — read badly four hours late, and the pass costs one query per
// candidate organisation.
function start() {
  if (!enabled()) {
    console.log('automatic email is off (EMAIL_SCHEDULER=off)');
    return null;
  }

  const go = () => runOnce()
    .then((r) => {
      if (!r) return;
      const { decided, sent } = r;
      if (decided.written || sent.sent || sent.failed) {
        console.log('email: decided ' + decided.written + ' message' +
          (decided.written === 1 ? '' : 's') + ', sent ' + sent.sent +
          (sent.held ? ', held ' + sent.held : '') +
          (sent.retrying ? ', retrying ' + sent.retrying : '') +
          (sent.failed ? ', failed ' + sent.failed : '') +
          ' in ' + r.seconds + 's');
      }
      if (decided.failed.length) {
        console.error('email: ' + decided.failed.length + ' organisations could not be evaluated');
      }
    })
    .catch((err) => console.error('email pass failed:', err.message));

  setTimeout(go, 90 * 1000).unref();
  setInterval(go, INTERVAL_MS).unref();
  return true;
}

// What /api/health reports. Names a state, never a credential.
function describe() {
  return {
    scheduler: enabled() ? 'on' : 'off',
    provider: provider.describe(),
    lastRun: last ? { at: last.at, decided: last.decided.written, sent: last.sent.sent } : null
  };
}

const warnings = () => (enabled() ? provider.warnings() : []);

// Evaluate and send for one organisation, now, rather than waiting up to a
// quarter of an hour for the pass. Used where the delay would be felt: a
// welcome email that arrives fifteen minutes after signing up has missed the
// moment somebody was actually looking.
//
// Never throws and is never awaited by the thing that triggered it. Signing
// up must not fail because a mail server is slow, and a payment must not.
function nudge(organizationId) {
  if (!enabled() || !organizationId) return;
  setImmediate(() => {
    run({ organizationId, sendLimit: 10 })
      .catch((err) => console.error('email nudge for ' + organizationId + ' failed: ' + err.message));
  });
}

// A payment confirmed. The conditions already decline to re-qualify — every
// trial step tests `onTrial` and `!paying` — so this cancels nothing that
// would have been sent anyway. It is for the one case the conditions cannot
// reach: a reminder already written and waiting out quiet hours, which would
// otherwise land the morning after the money was taken.
function paymentConfirmed(organizationId) {
  if (!organizationId) return;
  setImmediate(() => {
    outbox.cancelTrialReminders(organizationId, 'payment confirmed before it was sent')
      .then((cancelled) => {
        if (cancelled.length) {
          console.log('email: cancelled ' + cancelled.length + ' trial reminder' +
            (cancelled.length === 1 ? '' : 's') + ' after payment');
        }
        nudge(organizationId);
      })
      .catch((err) => console.error('email: cancelling trial reminders failed: ' + err.message));
  });
}

module.exports = {
  run, runOnce, start, enabled, describe, warnings, nudge, paymentConfirmed,
  lastRun: () => last,
  LOCK_KEY, outbox, journey, consent, provider
};
