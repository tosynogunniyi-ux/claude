// Putting the existing books into the ledger.
//
// There are years of cash-book rows and invoices that predate double entry.
// Without them the ledger is a true but empty record, and a balance sheet
// that starts from today is no use to anybody.
//
// Three properties this has to have, in order of how expensive getting them
// wrong would be:
//
//   Idempotent. Every entry carries a source key with a unique index behind
//   it, so running this twice posts nothing twice. That is what makes it safe
//   to run at boot, by hand, after a failure, or all three.
//
//   Ordered. Opening balances, then invoices issued, then bills, then cash.
//   A payment posts against a receivable, so the receivable has to exist
//   first or the account goes negative on the way through.
//
//   Batched and interruptible. It takes a Postgres advisory lock, works in
//   chunks, and a container that dies halfway leaves a consistent ledger that
//   the next run continues from.

const { pool, many, one } = require('../db');
const post = require('./post');

const LOCK_KEY = 4820773;          // billing 4820771, backups 4820772
const BATCH = Number(process.env.GL_BACKFILL_BATCH || 500);

const enabled = () => String(process.env.GL_BACKFILL || 'on').toLowerCase() !== 'off';

let last = null;

// Organisations with anything still unposted. Asked rather than assumed, so a
// second run over a finished database does almost no work.
//
// `only` narrows it to one organisation — what the Control Center's "post now"
// uses, and what a test needs so it does not quietly post every other
// business's history as a side effect of checking its own.
function pending(only) {
  if (only) {
    return many(
      `SELECT o.id, o.name FROM organizations o WHERE o.id = $1
        AND (EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.organization_id = o.id
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'transaction:' || t.id))
          OR EXISTS (
              SELECT 1 FROM invoices i
               WHERE i.organization_id = o.id AND i.base_status <> 'draft'
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'invoice:' || i.id || ':issue'))
          OR EXISTS (
              SELECT 1 FROM bills b
               WHERE b.organization_id = o.id AND b.base_status <> 'draft'
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'bill:' || b.id || ':issue')))`,
      [only]
    );
  }
  return many(
    `SELECT o.id, o.name
       FROM organizations o
      WHERE EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.organization_id = o.id
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'transaction:' || t.id))
         OR EXISTS (
              SELECT 1 FROM invoices i
               WHERE i.organization_id = o.id AND i.base_status <> 'draft'
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'invoice:' || i.id || ':issue'))
         OR EXISTS (
              SELECT 1 FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE i.organization_id = o.id
                 AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ref_payment_id = p.id)
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'payment:' || p.id))
         OR EXISTS (
              SELECT 1 FROM bill_payments p JOIN bills b ON b.id = p.bill_id
               WHERE b.organization_id = o.id
                 AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ref_payment_id = p.id)
                 AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                  WHERE j.organization_id = o.id AND j.source_key = 'billpayment:' || p.id))
      ORDER BY o.created_at`
  );
}

async function organisation(client, orgId) {
  const counts = { opening: 0, invoices: 0, bills: 0, payments: 0, transactions: 0, skipped: 0 };

  // 1. Opening balances, so the cash accounts start where they really started.
  const opened = await post.openingBalances(client, { orgId });
  counts.opening = opened.filter((e) => e && !e.alreadyPosted).length;

  // 2. Invoices. A historical invoice has a total and no line items and no
  // recorded tax split — so it posts as revenue with no VAT, which is the
  // honest reading. Inventing a VAT portion that was never recorded would be
  // worse than leaving it out.
  const invoices = await client.query(
    `SELECT i.* FROM invoices i
      WHERE i.organization_id = $1 AND i.base_status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM journal_entries j
                         WHERE j.organization_id = $1 AND j.source_key = 'invoice:' || i.id || ':issue')
      ORDER BY i.issue_date LIMIT $2`,
    [orgId, BATCH]
  );
  for (const invoice of invoices.rows) {
    const lines = (await client.query(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position', [invoice.id]
    )).rows;

    const net = lines.length
      ? lines.reduce((a, l) => a + Number(l.net_kobo), 0)
      : Number(invoice.subtotal_kobo || invoice.total_kobo || 0);
    const tax = lines.reduce((a, l) => a + Number(l.tax_kobo), 0);
    const total = lines.length ? net + tax : Number(invoice.total_kobo || 0);
    if (!total) { counts.skipped++; continue; }

    const entry = await post.invoiceIssued(client, {
      orgId,
      invoice,
      lines: lines.map((l) => ({
        description: l.description, net: Number(l.net_kobo), category: invoice.category
      })),
      totals: { net: lines.length ? net : total, tax, total }
    });
    if (entry && !entry.alreadyPosted) counts.invoices++;
  }

  // 3. Bills, the mirror of invoices, so payables exist before payments
  // against them.
  const bills = await client.query(
    `SELECT b.* FROM bills b
      WHERE b.organization_id = $1 AND b.base_status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM journal_entries j
                         WHERE j.organization_id = $1 AND j.source_key = 'bill:' || b.id || ':issue')
      ORDER BY b.issue_date LIMIT $2`,
    [orgId, BATCH]
  );
  for (const bill of bills.rows) {
    const entry = await post.billIssued(client, { orgId, bill });
    if (entry && !entry.alreadyPosted) counts.bills++;
  }

  // 4. Payments recorded straight onto a document, with no cash-book row
  // behind them. The payment route writes both, but the demo seeder and any
  // direct import write only the payment — and without this they are
  // invisible to the ledger, so a receivable stays open forever against money
  // that has already arrived.
  //
  // Settled from exactly one side: when a cash-book row references the
  // payment, step 5 handles it and this skips it. Posting both would halve
  // the receivable twice.
  const direct = await client.query(
    `SELECT p.*, i.number, i.client_name, i.id AS invoice_id
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ref_payment_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM journal_entries j
                         WHERE j.organization_id = $1 AND j.source_key = 'payment:' || p.id)
      ORDER BY p.date LIMIT $2`,
    [orgId, BATCH]
  );
  for (const p of direct.rows) {
    const entry = await post.invoicePaid(client, {
      orgId,
      invoice: { id: p.invoice_id, number: p.number, client_name: p.client_name },
      payment: p,
      amountKobo: Math.round(Number(p.amount) * 100)
    });
    if (entry && !entry.alreadyPosted) counts.payments++;
  }

  const directBills = await client.query(
    `SELECT p.*, b.number, b.vendor_name
       FROM bill_payments p
       JOIN bills b ON b.id = p.bill_id
      WHERE b.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ref_payment_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM journal_entries j
                         WHERE j.organization_id = $1 AND j.source_key = 'billpayment:' || p.id)
      ORDER BY p.date LIMIT $2`,
    [orgId, BATCH]
  );
  for (const p of directBills.rows) {
    const entry = await post.billPaid(client, {
      orgId,
      bill: { number: p.number, vendor_name: p.vendor_name },
      payment: p,
      amountKobo: Math.round(Number(p.amount) * 100)
    });
    if (entry && !entry.alreadyPosted) counts.payments++;
  }

  // 5. The cash book. Last, because an invoice payment posts against the
  // receivable raised in step 2.
  const txs = await client.query(
    `SELECT t.* FROM transactions t
      WHERE t.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM journal_entries j
                         WHERE j.organization_id = $1 AND j.source_key = 'transaction:' || t.id)
      ORDER BY t.date LIMIT $2`,
    [orgId, BATCH]
  );
  for (const tx of txs.rows) {
    const entry = await post.cashTransaction(client, { orgId, tx });
    if (entry && !entry.alreadyPosted) counts.transactions++;
    else if (!entry) counts.skipped++;
  }

  return counts;
}

// One pass. Returns what it did, so a caller — the boot hook, the console, a
// test — can say whether anything is left.
async function run({ limit, organizationId } = {}) {
  const started = Date.now();
  const orgs = await pending(organizationId);
  const todo = limit ? orgs.slice(0, limit) : orgs;
  const totals = { organisations: 0, opening: 0, invoices: 0, bills: 0, payments: 0, transactions: 0, skipped: 0, failed: [] };

  for (const org of todo) {
    const client = await pool.connect();
    try {
      // Per organisation, so one business's bad row cannot roll back
      // another's work or hold a transaction open across the whole database.
      await client.query('BEGIN');
      const counts = await organisation(client, org.id);
      await client.query('COMMIT');
      totals.organisations++;
      for (const k of ['opening', 'invoices', 'bills', 'payments', 'transactions', 'skipped']) totals[k] += counts[k];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Reported, not thrown: one organisation with an unpostable row must
      // not stop every other organisation getting its ledger.
      totals.failed.push({ organization: org.id, name: org.name, error: err.message });
      console.error('ledger backfill failed for ' + org.name + ': ' + err.message);
    } finally {
      client.release();
    }
  }

  totals.seconds = Math.round((Date.now() - started) / 1000);
  totals.remaining = (await pending(organizationId)).length;
  last = Object.assign({ at: new Date().toISOString() }, totals);
  return totals;
}

// Under the advisory lock, so more than one container does not post the same
// history twice. The unique index would catch it, but queueing is cheaper
// than a thousand conflicts.
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

// Called at boot, after the server is already answering: this is history
// catching up, not something a request waits for.
function start() {
  if (!enabled()) {
    console.log('ledger backfill is off (GL_BACKFILL=off)');
    return null;
  }
  const go = () => runOnce()
    .then((r) => {
      if (!r) return;
      if (r.organisations === 0) {
        console.log('ledger: already complete, nothing to post');
      } else {
        console.log('ledger: posted ' + r.invoices + ' invoices, ' + r.bills + ' bills, ' +
          r.transactions + ' cash entries across ' + r.organisations + ' organisations in ' +
          r.seconds + 's' + (r.remaining ? ' (' + r.remaining + ' still to do)' : ''));
      }
      if (r.failed.length) console.error('ledger: ' + r.failed.length + ' organisations failed');
      // More to do than one batch allowed — come back for the rest rather
      // than holding the lock for an hour.
      if (r.remaining) setTimeout(go, 30 * 1000).unref();
    })
    .catch((err) => console.error('ledger backfill failed:', err.message));

  setTimeout(go, 20 * 1000).unref();
  return true;
}

module.exports = { run, runOnce, start, pending, enabled, lastRun: () => last, LOCK_KEY };
