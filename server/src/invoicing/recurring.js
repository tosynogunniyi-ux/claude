// Invoices that raise themselves.
//
// Three properties this has to have, in order of what getting them wrong
// would cost:
//
//   Never twice. A customer billed twice for March will notice, and will
//   assume the rest of their account is equally reliable. The generator
//   advances the schedule inside the same transaction that writes the
//   invoice, and a unique index on (schedule, occurrence) catches everything
//   that is not the generator — two containers racing, a retried run,
//   somebody pressing "Run now" twice.
//
//   Never silently. A schedule that cannot raise its invoice — closed books,
//   a deleted customer, figures that no longer add up — records why and
//   stops, rather than failing once a month into a log nobody reads.
//
//   The right date. A monthly schedule anchored on the 31st bills on the 31st
//   of every month that has one and the last day of every month that does
//   not, and then goes back to the 31st. Computing it as "add 30 days" or as
//   "clamp and continue" walks the date backwards a little every year, which
//   nobody notices until a customer asks why their January invoice arrived on
//   the 26th.

const { pool, many, one } = require('../db');
const issue = require('./issue');
const money = require('../money');

const LOCK_KEY = 4820774;      // billing 4820771, backups 4820772, ledger 4820773
const BATCH = Number(process.env.RECURRING_BATCH || 200);
const INTERVAL_MS = Number(process.env.RECURRING_INTERVAL_MS || 60 * 60 * 1000);

const enabled = () => String(process.env.RECURRING_SCHEDULER || 'on').toLowerCase() !== 'off';

let last = null;

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MONTHS_IN = { monthly: 1, quarterly: 3, yearly: 12 };

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ------------------------------------------------------------------ the dates
//
// All of this is string arithmetic on YYYY-MM-DD and integer maths. Nothing
// here constructs a Date and adds milliseconds: a server in Lagos, a server
// in UTC and a day on which the clocks change must all produce the same
// invoice date, and `new Date(d).setMonth(...)` does not promise that.

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function parse(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
}

const format = (y, m, d) =>
  String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');

// Add whole months, keeping the anchor day. The 31st of January plus one
// month is the 28th of February — and plus two months is the 31st of March,
// not the 28th, because the anchor is remembered rather than carried forward
// from wherever the last clamp landed.
function addMonths(iso, months, anchorDay) {
  const at = parse(iso);
  const anchor = anchorDay || at.d;
  const zero = (at.y * 12 + (at.m - 1)) + months;
  const y = Math.floor(zero / 12);
  const m = (zero % 12) + 1;
  return format(y, m, Math.min(anchor, daysInMonth(y, m)));
}

function addDays(iso, days) {
  const at = parse(iso);
  const ms = Date.UTC(at.y, at.m - 1, at.d) + days * 86400000;
  const d = new Date(ms);
  return format(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// The occurrence after this one.
function advance(iso, frequency, intervalCount, anchorDay) {
  const n = Math.max(1, Number(intervalCount) || 1);
  if (frequency === 'weekly') return addDays(iso, 7 * n);
  return addMonths(iso, MONTHS_IN[frequency] * n, anchorDay);
}

// What a schedule would raise, and when, without raising anything. For the
// screen, and for anybody checking a schedule before switching it on.
function preview(schedule, count = 6) {
  const out = [];
  let at = schedule.next_due;
  let issued = Number(schedule.issued_count) || 0;
  for (let i = 0; i < count; i++) {
    if (schedule.end_date && at > schedule.end_date) break;
    if (schedule.max_occurrences && issued >= schedule.max_occurrences) break;
    out.push({ issue: at, due: addDays(at, Number(schedule.due_days) || 0), occurrence: issued + 1 });
    issued += 1;
    at = advance(at, schedule.frequency, schedule.interval_count, anchorOf(schedule));
  }
  return out;
}

// The day of the month a monthly-ish schedule is anchored to. Taken from the
// start date, so a schedule that began on the 31st keeps billing on the 31st
// however many short months it passes through.
const anchorOf = (schedule) =>
  schedule.frequency === 'weekly' ? null : parse(schedule.start_date).d;

// Why a schedule should stop, or null if it should not. Checked before each
// occurrence rather than once at the end, so a schedule that has reached its
// limit does not sit "active" with a date in the past.
function exhausted(schedule) {
  if (schedule.end_date && schedule.next_due > schedule.end_date) return 'ended';
  if (schedule.max_occurrences && Number(schedule.issued_count) >= Number(schedule.max_occurrences)) {
    return 'completed';
  }
  return null;
}

// --------------------------------------------------------------- the writing

// Raise exactly the one invoice a schedule is pointing at, and move it on.
//
// Takes a client inside an open transaction, with the schedule row already
// locked. The lock and the advance in the same transaction are what make this
// safe to run from two containers at once.
async function issueOne(client, schedule) {
  const lines = (await client.query(
    'SELECT * FROM recurring_invoice_lines WHERE recurring_invoice_id = $1 ORDER BY position, created_at',
    [schedule.id]
  )).rows;
  if (!lines.length) {
    throw Object.assign(new Error('This schedule has no lines, so there is nothing to invoice.'),
      { status: 400 });
  }

  const occurrence = Number(schedule.issued_count) + 1;
  const issueDate = schedule.next_due;

  const written = await issue.write(client, {
    orgId: schedule.organization_id,
    // No user: nobody pressed anything. The invoice's own event log says it
    // came from a schedule, which is more use than attributing it to whoever
    // happened to create the schedule months ago.
    userId: null,
    recurring: schedule.id,
    occurrence,
    source: 'recurring',
    body: {
      status: 'issued',
      party: schedule.client_name,
      clientId: schedule.client_id,
      issue: issueDate,
      due: addDays(issueDate, Number(schedule.due_days) || 0),
      taxInclusive: schedule.tax_inclusive === null ? undefined : schedule.tax_inclusive,
      billingAddress: schedule.billing_address,
      shippingAddress: schedule.shipping_address,
      customerReference: schedule.customer_reference,
      purchaseOrder: schedule.purchase_order,
      notes: schedule.notes,
      terms: schedule.terms,
      paymentInstructions: schedule.payment_instructions,
      template: schedule.template,
      category: schedule.category,
      // Back to what a person would have typed, because that is what
      // totals.compute reads — and recomputing here rather than storing the
      // figures means a VAT registration that happened last week reaches this
      // month's invoice.
      lines: lines.map((l) => ({
        description: l.description,
        itemId: l.item_id,
        unit: l.unit,
        qty: money.fromQty(Number(l.qty_milli)),
        unitPrice: money.toNaira(Number(l.unit_price_kobo)),
        discountAmount: Number(l.discount_kobo) ? money.toNaira(Number(l.discount_kobo)) : undefined,
        discountPercent: l.discount_bp === null || l.discount_bp === undefined
          ? undefined : money.fromBasisPoints(Number(l.discount_bp)),
        taxTreatment: l.tax_treatment,
        taxRate: l.tax_bp === null || l.tax_bp === undefined
          ? undefined : money.fromBasisPoints(Number(l.tax_bp)),
        whtRate: l.wht_bp === null || l.wht_bp === undefined
          ? undefined : money.fromBasisPoints(Number(l.wht_bp))
      }))
    }
  });

  const nextDue = advance(issueDate, schedule.frequency, schedule.interval_count, anchorOf(schedule));

  const moved = (await client.query(
    `UPDATE recurring_invoices
        SET issued_count = issued_count + 1,
            last_issued_on = $2,
            next_due = $3,
            last_error = NULL,
            last_run_at = now(),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [schedule.id, issueDate, nextDue]
  )).rows[0];

  return { invoice: written.invoice, totals: written.computed, schedule: moved, occurrence };
}

// Mark a schedule finished, with the reason on the record.
async function finish(client, scheduleId, reason) {
  return (await client.query(
    `UPDATE recurring_invoices
        SET status = 'finished', finished_at = now(), finished_reason = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [scheduleId, reason]
  )).rows[0];
}

// Everything one schedule owes, up to today. A schedule created with a start
// date in the past deliberately catches up: somebody setting up a retainer
// that began in June wants June through to now raised, not a single invoice
// dated today for five months of work.
//
// `limit` bounds the catch-up so a start date mistyped as 2015 produces a
// refusal to run away rather than a hundred and thirty invoices.
async function runSchedule(scheduleId, { asOf, limit = 36, userId } = {}) {
  const on = isDate(asOf) ? asOf : today();
  const raised = [];

  for (let i = 0; i < limit; i++) {
    const step = await oneOccurrence(scheduleId, on, userId);
    if (!step) break;
    if (step.failed) return { raised, failed: step.failed, schedule: step.schedule };
    // The invoice first, then the verdict: a schedule that reached its limit
    // on this very occurrence both raised one and finished, and reporting
    // only the second would lose the first.
    if (step.invoice) raised.push(step);
    if (step.stopped) return { raised, stopped: step.stopped, schedule: step.schedule };
    if (!step.more) return { raised, schedule: step.schedule };
  }
  // Hit the ceiling with work still to do: said rather than silently left.
  return { raised, capped: true };
}

// One occurrence, in its own transaction. Its own transaction and not the
// caller's, so a schedule that fails on its fourth catch-up invoice keeps the
// three it already raised — those are real invoices in the customer's hands
// as far as the books are concerned, and rolling them back to tidy up an
// error would be the worse outcome.
async function oneOccurrence(scheduleId, on, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SKIP LOCKED: another container already has this schedule, so leave it
    // to them rather than queueing behind it and raising the next occurrence
    // the moment they let go.
    const locked = (await client.query(
      `SELECT * FROM recurring_invoices WHERE id = $1 AND status = 'active'
        FOR UPDATE SKIP LOCKED`,
      [scheduleId]
    )).rows[0];
    if (!locked) { await client.query('ROLLBACK'); return null; }

    // Already finished before it raised anything — the limit was reached or
    // the end date passed while it sat waiting.
    const already = exhausted(locked);
    if (already) {
      const schedule = await finish(client, locked.id, already);
      await client.query('COMMIT');
      return { stopped: already, schedule };
    }
    if (locked.next_due > on) { await client.query('ROLLBACK'); return null; }

    const result = await issueOne(client, locked);

    // A schedule that has just raised its last invoice is finished now, in
    // this transaction — not when the next pass happens to look at it an hour
    // later. Otherwise the screen shows a completed schedule as running, with
    // a next date it will never reach.
    let after = result.schedule;
    const done = exhausted(after);
    if (done) after = await finish(client, after.id, done);

    await client.query('COMMIT');

    return {
      invoice: result.invoice,
      totals: result.totals,
      occurrence: result.occurrence,
      schedule: after,
      stopped: done || null,
      more: !done && after.next_due <= on
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // The unique index caught a duplicate — another container raised this
    // occurrence between our lock and our insert. Not a fault: the invoice
    // exists, which is what was wanted.
    if (err.code === '23505' && /recurring_once/.test(err.constraint || '')) {
      return null;
    }

    // Everything else is recorded against the schedule and stops it. A
    // schedule that fails every hour into a log nobody reads is worse than
    // one that is visibly stopped with the reason on it.
    await pool.query(
      `UPDATE recurring_invoices
          SET status = 'paused', paused_at = now(), last_error = $2,
              last_run_at = now(), updated_at = now()
        WHERE id = $1`,
      [scheduleId, String(err.message).slice(0, 500)]
    ).catch(() => {});
    return { failed: err.message, schedule: null };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- the pass

// Every schedule that is due, across every organisation — or inside one, when
// `organizationId` narrows it, which is what a test needs so it does not
// quietly bill every other business as a side effect of checking its own.
function due({ asOf, organizationId, limit = BATCH } = {}) {
  const on = isDate(asOf) ? asOf : today();
  const args = [on];
  let scope = '';
  if (organizationId) { args.push(organizationId); scope = 'AND r.organization_id = $2'; }
  return many(
    `SELECT r.id, r.organization_id, r.name, r.client_name, r.next_due
       FROM recurring_invoices r
      WHERE r.status = 'active' AND r.next_due <= $1 ${scope}
      ORDER BY r.next_due, r.created_at
      LIMIT ${Math.min(Number(limit) || BATCH, 1000)}`,
    args
  );
}

async function run({ asOf, organizationId, limit } = {}) {
  const started = Date.now();
  const on = isDate(asOf) ? asOf : today();
  const schedules = await due({ asOf: on, organizationId, limit });
  const totals = { schedules: schedules.length, invoices: 0, amount: 0, stopped: 0, failed: [] };

  for (const s of schedules) {
    const result = await runSchedule(s.id, { asOf: on });
    totals.invoices += result.raised.length;
    for (const r of result.raised) totals.amount += Number(r.totals.total);
    if (result.stopped) totals.stopped++;
    if (result.failed) {
      totals.failed.push({ schedule: s.id, name: s.name, organization: s.organization_id, error: result.failed });
      console.error('recurring invoice failed for "' + s.name + '": ' + result.failed);
    }
  }

  totals.seconds = Math.round((Date.now() - started) / 1000);
  last = Object.assign({ at: new Date().toISOString(), asOf: on }, totals);
  return totals;
}

// Under an advisory lock, so two containers do not both walk the due list.
// The unique index would catch the duplicates, but queueing is cheaper than
// a hundred conflicts and much cheaper than explaining them.
async function runOnce() {
  if (!enabled()) return null;
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0].ok) return null;
    try {
      return await run({});
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Hourly, and once shortly after boot. Hourly rather than daily because a
// container that is restarted every afternoon would otherwise never see
// midnight, and a schedule due today would wait until tomorrow.
function start() {
  if (!enabled()) {
    console.log('recurring invoices are off (RECURRING_SCHEDULER=off)');
    return null;
  }
  const go = () => runOnce()
    .then((r) => {
      if (!r) return;
      if (r.invoices) {
        console.log('recurring: raised ' + r.invoices + ' invoice' + (r.invoices === 1 ? '' : 's') +
          ' worth ' + money.format(r.amount) + ' from ' + r.schedules + ' schedule' +
          (r.schedules === 1 ? '' : 's') + ' in ' + r.seconds + 's');
      }
      if (r.failed.length) console.error('recurring: ' + r.failed.length + ' schedules failed');
    })
    .catch((err) => console.error('recurring invoices failed:', err.message));

  setTimeout(go, 45 * 1000).unref();
  setInterval(go, INTERVAL_MS).unref();
  return true;
}

module.exports = {
  run, runOnce, runSchedule, oneOccurrence, start, due, preview,
  advance, addDays, addMonths, anchorOf, exhausted, issueOne, finish,
  enabled, lastRun: () => last,
  FREQUENCIES, MONTHS_IN, LOCK_KEY
};
