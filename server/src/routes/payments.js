// Payments and receivables.
//
// Mounted inside the org-scoped router, so requireOrg has already decided
// that this caller belongs to these books. Every query below is scoped by
// req.orgId regardless, because a single choke point is a policy and a scoped
// query is a guarantee.
//
// What a role may do here follows the money, not the screen: a viewer reads
// every figure, an accountant records and allocates, and only an admin can
// touch the credentials that collect real money or reverse something that has
// already been posted.

const express = require('express');
const { one, many, tx: transaction } = require('../db');
const { requireOrg, audit } = require('../auth');
const money = require('../money');
const owed = require('../invoicing/outstanding');
const merchant = require('../payments/merchant');
const receipts = require('../payments/receipts');
const creditNotes = require('../payments/credit-notes');
const collect = require('../payments/collect');
const providers = require('../payments/providers');
const banking = require('./banking');
const accounting = require('../accounting/reports');

const router = express.Router({ mergeParams: true });

const today = () => new Date().toISOString().slice(0, 10);

// Where this server is, for the webhook URL a tenant pastes into their
// provider's dashboard. Taken from the request rather than configuration,
// because a deployment that has moved should not keep printing its old
// address — and the one place it matters is a URL somebody is about to copy.
function baseUrlOf(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

function reply(res, err, next) {
  if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  return next(err);
}

// ------------------------------------------------------- merchant credentials

// What the settings screen draws. No secret, no ciphertext, no webhook token
// beyond the URL it belongs in — and that URL is only shown to an admin.
router.get('/payment-accounts', requireOrg('admin'), async (req, res, next) => {
  try {
    res.json(await merchant.describe(req.orgId, { baseUrl: baseUrlOf(req) }));
  } catch (err) { reply(res, err, next); }
});

router.put('/payment-accounts/:provider', requireOrg('admin'), async (req, res, next) => {
  try {
    const result = await merchant.save(req.orgId, req.params.provider, req.body || {}, {
      userId: req.user.id
    });
    // The secret is never logged, never audited and never echoed. What is
    // recorded is that it changed and who changed it.
    await audit(req.orgId, req.user.id, 'merchant.saved', 'merchant_account', result.account.id, {
      provider: result.account.provider,
      environment: result.account.environment,
      secretReplaced: Boolean(result.account.secret_hint)
    });
    res.json({
      saved: true,
      notes: result.notes,
      // Saved is not working. Nothing is active until the provider itself has
      // accepted the credentials.
      next: 'Press Test to prove these credentials against ' +
        providers.get(req.params.provider).label + '. Until that succeeds, no invoice will offer a Pay button.',
      accounts: await merchant.describe(req.orgId, { baseUrl: baseUrlOf(req) })
    });
  } catch (err) { reply(res, err, next); }
});

router.post('/payment-accounts/:provider/test', requireOrg('admin'), async (req, res, next) => {
  try {
    const result = await merchant.verifyAccount(req.orgId, req.params.provider);
    await audit(req.orgId, req.user.id, 'merchant.verified', 'merchant_account', result.account.id, {
      provider: req.params.provider, mode: result.mode
    });
    res.json({
      ok: true, mode: result.mode, mismatch: result.mismatch,
      accounts: await merchant.describe(req.orgId, { baseUrl: baseUrlOf(req) })
    });
  } catch (err) { reply(res, err, next); }
});

router.post('/payment-accounts/:provider/active', requireOrg('admin'), async (req, res, next) => {
  try {
    const active = (req.body || {}).active !== false;
    const row = await merchant.setActive(req.orgId, req.params.provider, active);
    await audit(req.orgId, req.user.id, active ? 'merchant.enabled' : 'merchant.disabled',
      'merchant_account', row.id, { provider: req.params.provider });
    res.json({ active: row.active, accounts: await merchant.describe(req.orgId, { baseUrl: baseUrlOf(req) }) });
  } catch (err) { reply(res, err, next); }
});

router.delete('/payment-accounts/:provider', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await merchant.remove(req.orgId, req.params.provider);
    if (!row) return res.status(404).json({ error: 'Nothing was saved for that provider.' });
    await audit(req.orgId, req.user.id, 'merchant.removed', 'merchant_account', row.id,
      { provider: row.provider });
    res.json({ removed: true, accounts: await merchant.describe(req.orgId, { baseUrl: baseUrlOf(req) }) });
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------------------ receipts

// What a payment form needs to open: who owes what, which bank accounts
// exist, and whether online collection is available. One call, so the form is
// never half-populated while a second request is in flight.
router.get('/payments/new', requireOrg('accountant'), async (req, res, next) => {
  try {
    const [customers, accounts, collection, open] = await Promise.all([
      many(
        `SELECT c.id, c.name, c.email,
                COALESCE(SUM(${owed.outstanding('i')}) FILTER (
                  WHERE i.base_status <> 'draft' AND i.voided_at IS NULL
                    AND ${owed.outstanding('i')} > 0), 0) AS owing
           FROM clients c LEFT JOIN invoices i ON i.client_id = c.id AND i.organization_id = c.organization_id
          WHERE c.organization_id = $1
          GROUP BY c.id, c.name, c.email ORDER BY owing DESC, c.name LIMIT 500`,
        [req.orgId]
      ),
      banking.accountsWithBalances(req.orgId),
      merchant.collectionState(req.orgId),
      many(
        `SELECT i.id, i.number, i.client_name AS party, i.client_id, i.issue_date, i.due_date,
                i.total_kobo AS total, ${owed.outstanding('i')} AS outstanding
           FROM invoices i
          WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL
            AND ${owed.outstanding('i')} > 0
          ORDER BY i.due_date, i.issue_date LIMIT 300`,
        [req.orgId]
      )
    ]);

    res.json({
      methods: receipts.METHOD_KEYS.map((k) => ({ key: k, label: receipts.METHODS[k] })),
      customers: customers.map((c) => ({
        id: c.id, name: c.name, email: c.email, owing: Number(c.owing)
      })),
      bankAccounts: accounts.map((a) => ({ id: a.id, name: a.name, bank: a.bankName || a.bank_name })),
      openInvoices: open.map((i) => ({
        id: i.id, number: i.number, party: i.party, clientId: i.client_id,
        issue: i.issue_date, due: i.due_date,
        total: Number(i.total), outstanding: Number(i.outstanding)
      })),
      collection,
      today: today()
    });
  } catch (err) { reply(res, err, next); }
});

// Oldest-first, as a suggestion. Never applied on its own.
router.get('/payments/suggest', requireOrg('accountant'), async (req, res, next) => {
  try {
    const rows = await transaction((client) => receipts.suggest(client, req.orgId, {
      party: req.query.party,
      clientId: req.query.clientId,
      amountKobo: money.toKobo(req.query.amount)
    }));
    res.json({ invoices: rows, allocated: rows.reduce((a, r) => a + r.suggested, 0) });
  } catch (err) { reply(res, err, next); }
});

// Record money that has arrived.
router.post('/payments', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amountKobo = b.amountKobo !== undefined ? Math.round(Number(b.amountKobo)) : money.toKobo(b.amount);

    const result = await transaction((client) => receipts.record(client, {
      orgId: req.orgId,
      userId: req.user.id,
      bookType: req.bookType,
      party: b.party,
      clientId: b.clientId || null,
      receivedOn: b.date,
      amountKobo,
      method: b.method,
      bankAccountId: b.bankAccountId || null,
      reference: b.reference,
      notes: b.notes,
      allocations: b.allocations
    }));

    await audit(req.orgId, req.user.id, 'payment.recorded', 'customer_payment', result.receipt.id, {
      amount: amountKobo,
      receipt: result.receipt.receipt_number,
      invoices: (result.invoices || []).map((i) => i.number)
    });

    res.status(201).json(await detail(req.orgId, result.receipt.id));
  } catch (err) { reply(res, err, next); }
});

// Put money already received against invoices.
router.post('/payments/:id/allocate', requireOrg('accountant'), async (req, res, next) => {
  try {
    const result = await transaction((client) => receipts.allocate(client, {
      orgId: req.orgId, userId: req.user.id,
      receiptId: req.params.id,
      allocations: (req.body || {}).allocations
    }));
    await audit(req.orgId, req.user.id, 'payment.allocated', 'customer_payment', req.params.id, {
      invoices: result.invoices.map((i) => i.number),
      amount: result.allocations.reduce((a, r) => a + Number(r.amount_kobo), 0)
    });
    res.json(await detail(req.orgId, req.params.id));
  } catch (err) { reply(res, err, next); }
});

// A gateway payment reaching the bank, with the processor's fee recognised.
router.post('/payments/:id/settle', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await transaction((client) => receipts.settle(client, {
      orgId: req.orgId, userId: req.user.id,
      receiptId: req.params.id,
      bankAccountId: b.bankAccountId || null,
      feeKobo: b.feeKobo !== undefined ? Math.round(Number(b.feeKobo)) : money.toKobo(b.fee),
      settledOn: b.date
    }));
    await audit(req.orgId, req.user.id, 'payment.settled', 'customer_payment', row.id,
      { fee: Number(row.fee_kobo) });
    res.json(await detail(req.orgId, row.id));
  } catch (err) { reply(res, err, next); }
});

// Undoing one. Admin only, and a reversal rather than a delete.
router.post('/payments/:id/reverse', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await transaction((client) => receipts.reverse(client, {
      orgId: req.orgId, userId: req.user.id,
      receiptId: req.params.id,
      reason: (req.body || {}).reason,
      on: (req.body || {}).date
    }));
    await audit(req.orgId, req.user.id, 'payment.reversed', 'customer_payment', row.id,
      { receipt: row.receipt_number, reason: (req.body || {}).reason || null });
    res.json(await detail(req.orgId, row.id));
  } catch (err) { reply(res, err, next); }
});

// One receipt, everything about it.
async function detail(orgId, id) {
  const receipt = await one(
    `SELECT c.*, ${owed.unallocated('c')} AS unallocated, b.name AS bank_name
       FROM customer_payments c LEFT JOIN bank_accounts b ON b.id = c.bank_account_id
      WHERE c.organization_id = $1 AND c.id = $2`,
    [orgId, id]
  );
  if (!receipt) return null;

  const allocations = await many(
    `SELECT p.id, p.amount_kobo, p.date, i.id AS invoice_id, i.number, i.total_kobo,
            ${owed.outstanding('i')} AS outstanding
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.customer_payment_id = $1 ORDER BY p.created_at`,
    [id]
  );

  return {
    receipt: {
      id: receipt.id,
      number: receipt.receipt_number,
      party: receipt.party,
      clientId: receipt.client_id,
      date: receipt.received_on,
      amount: Number(receipt.amount_kobo),
      allocated: Number(receipt.amount_kobo) - Number(receipt.unallocated),
      unallocated: Number(receipt.unallocated),
      method: receipt.method,
      methodLabel: receipts.METHODS[receipt.method] || receipt.method,
      source: receipt.source,
      provider: receipt.provider,
      providerReference: receipt.provider_reference,
      reference: receipt.reference,
      bankAccountId: receipt.bank_account_id,
      bankName: receipt.bank_name,
      notes: receipt.notes,
      status: receipt.status,
      settledAt: receipt.settled_at,
      fee: Number(receipt.fee_kobo),
      // A gateway payment that has not settled is with the processor, not in
      // the bank. Said on the row rather than left to be worked out from two
      // other fields.
      inTransit: receipt.source === 'gateway' && !receipt.settled_at
    },
    allocations: allocations.map((a) => ({
      id: a.id, invoiceId: a.invoice_id, number: a.number,
      amount: Number(a.amount_kobo), date: a.date,
      invoiceTotal: Number(a.total_kobo), invoiceOutstanding: Number(a.outstanding)
    }))
  };
}

router.get('/payments/:id', requireOrg(), async (req, res, next) => {
  try {
    const data = await detail(req.orgId, req.params.id);
    if (!data) return res.status(404).json({ error: 'No such payment.' });
    res.json(data);
  } catch (err) { reply(res, err, next); }
});

// The receipts table, filtered and paged server-side.
router.get('/payments', requireOrg(), async (req, res, next) => {
  try {
    const where = ['c.organization_id = $1'];
    const args = [req.orgId];
    const add = (sql, v) => { args.push(v); where.push(sql.replace(/\$n/g, '$' + args.length)); };

    const q = String(req.query.q || '').trim();
    if (q) add('(c.party ILIKE $n OR c.receipt_number ILIKE $n OR c.reference ILIKE $n)', '%' + q + '%');
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from))) add('c.received_on >= $n', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) add('c.received_on <= $n', req.query.to);
    if (String(req.query.method || '').trim()) add('c.method = $n', receipts.methodKey(req.query.method));
    if (String(req.query.source || '').trim() === 'gateway') where.push("c.source = 'gateway'");
    if (String(req.query.source || '').trim() === 'manual') where.push("c.source = 'manual'");
    if (String(req.query.status || '') === 'unallocated') where.push(owed.unallocated('c') + ' > 0');
    if (String(req.query.status || '') === 'in_transit') where.push("c.source = 'gateway' AND c.settled_at IS NULL AND c.status = 'received'");
    if (String(req.query.status || '') === 'reversed') where.push("c.status = 'reversed'");

    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows, summary] = await Promise.all([
      many(
        `SELECT c.*, ${owed.unallocated('c')} AS unallocated,
                (SELECT string_agg(i.number, ', ' ORDER BY i.number)
                   FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
                  WHERE p.customer_payment_id = c.id) AS against
           FROM customer_payments c WHERE ${where.join(' AND ')}
          ORDER BY c.received_on DESC, c.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
        args
      ),
      one(
        `SELECT COUNT(*)::int n,
                COALESCE(SUM(c.amount_kobo) FILTER (WHERE c.status <> 'reversed'), 0) AS received,
                COALESCE(SUM(${owed.unallocated('c')}) FILTER (WHERE c.status <> 'reversed'), 0) AS unallocated,
                COALESCE(SUM(c.fee_kobo), 0) AS fees
           FROM customer_payments c WHERE ${where.join(' AND ')}`,
        args
      )
    ]);

    res.json({
      payments: rows.map((r) => ({
        id: r.id, number: r.receipt_number, party: r.party, date: r.received_on,
        amount: Number(r.amount_kobo), unallocated: Number(r.unallocated),
        allocated: Number(r.amount_kobo) - Number(r.unallocated),
        method: r.method, methodLabel: receipts.METHODS[r.method] || r.method,
        source: r.source, provider: r.provider, status: r.status,
        against: r.against || null, fee: Number(r.fee_kobo),
        inTransit: r.source === 'gateway' && !r.settled_at
      })),
      total: summary.n,
      received: Number(summary.received),
      unallocated: Number(summary.unallocated),
      fees: Number(summary.fees),
      limit, offset
    });
  } catch (err) { reply(res, err, next); }
});

// -------------------------------------------------------------- credit notes

router.get('/credit-notes/from-invoice/:invoiceId', requireOrg('accountant'), async (req, res, next) => {
  try {
    const draft = await transaction((client) => creditNotes.fromInvoice(client, req.orgId, req.params.invoiceId));
    res.json(draft);
  } catch (err) { reply(res, err, next); }
});

router.post('/credit-notes', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await transaction((client) => creditNotes.issue(client, {
      orgId: req.orgId, userId: req.user.id,
      invoiceId: b.invoiceId || null,
      party: b.party, clientId: b.clientId || null,
      issueDate: b.issue, reason: b.reason,
      lines: b.lines,
      status: b.status === 'draft' ? 'draft' : 'issued',
      applyNow: b.applyNow
    }));
    await audit(req.orgId, req.user.id,
      result.note.status === 'draft' ? 'credit_note.drafted' : 'credit_note.issued',
      'credit_note', result.note.id,
      { number: result.note.number, total: Number(result.note.total_kobo) });
    res.status(201).json(await noteDetail(req.orgId, result.note.id));
  } catch (err) { reply(res, err, next); }
});

router.post('/credit-notes/:id/apply', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await transaction((client) => creditNotes.apply(client, {
      orgId: req.orgId, noteId: req.params.id,
      invoiceId: b.invoiceId,
      amountKobo: b.amountKobo !== undefined ? Math.round(Number(b.amountKobo))
        : b.amount !== undefined ? money.toKobo(b.amount) : null,
      on: b.date
    }));
    await audit(req.orgId, req.user.id, 'credit_note.applied', 'credit_note', req.params.id,
      { invoice: result.invoiceNumber, amount: result.amount });
    res.json(await noteDetail(req.orgId, req.params.id));
  } catch (err) { reply(res, err, next); }
});

router.post('/credit-notes/:id/void', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await transaction((client) => creditNotes.voidNote(client, {
      orgId: req.orgId, userId: req.user.id, noteId: req.params.id,
      reason: (req.body || {}).reason, on: (req.body || {}).date
    }));
    await audit(req.orgId, req.user.id, 'credit_note.voided', 'credit_note', row.id,
      { number: row.number, reason: (req.body || {}).reason || null });
    res.json(await noteDetail(req.orgId, row.id));
  } catch (err) { reply(res, err, next); }
});

async function noteDetail(orgId, id) {
  const note = await one(
    `SELECT n.*, ${owed.unapplied('n')} AS unapplied, i.number AS invoice_number
       FROM credit_notes n LEFT JOIN invoices i ON i.id = n.invoice_id
      WHERE n.organization_id = $1 AND n.id = $2`,
    [orgId, id]
  );
  if (!note) return null;

  const [lines, applications] = await Promise.all([
    many('SELECT * FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY position', [id]),
    many(
      `SELECT a.id, a.amount_kobo, a.applied_on, i.id AS invoice_id, i.number
         FROM credit_note_applications a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.credit_note_id = $1 ORDER BY a.created_at`,
      [id]
    )
  ]);

  return {
    note: {
      id: note.id, number: note.number, party: note.client_name, clientId: note.client_id,
      invoiceId: note.invoice_id, invoiceNumber: note.invoice_number,
      issue: note.issue_date, reason: note.reason,
      net: Number(note.subtotal_kobo), tax: Number(note.tax_kobo), total: Number(note.total_kobo),
      applied: Number(note.total_kobo) - Number(note.unapplied),
      unapplied: Number(note.unapplied),
      status: note.status, issuedAt: note.issued_at, voidedAt: note.voided_at
    },
    lines: lines.map((l) => ({
      description: l.description, qty: Number(l.qty_milli), unitPrice: Number(l.unit_price_kobo),
      treatment: l.tax_treatment, taxBp: l.tax_bp,
      net: Number(l.net_kobo), tax: Number(l.tax_kobo), total: Number(l.total_kobo)
    })),
    applications: applications.map((a) => ({
      id: a.id, invoiceId: a.invoice_id, number: a.number,
      amount: Number(a.amount_kobo), date: a.applied_on
    }))
  };
}

router.get('/credit-notes/:id', requireOrg(), async (req, res, next) => {
  try {
    const data = await noteDetail(req.orgId, req.params.id);
    if (!data) return res.status(404).json({ error: 'No such credit note.' });
    res.json(data);
  } catch (err) { reply(res, err, next); }
});

router.get('/credit-notes', requireOrg(), async (req, res, next) => {
  try {
    const where = ['n.organization_id = $1'];
    const args = [req.orgId];
    const q = String(req.query.q || '').trim();
    if (q) { args.push('%' + q + '%'); where.push('(n.number ILIKE $2 OR n.client_name ILIKE $2)'); }
    const status = String(req.query.status || 'all');
    if (status === 'issued' || status === 'draft' || status === 'void') {
      args.push(status); where.push('n.status = $' + args.length);
    }
    if (status === 'open') where.push("n.status = 'issued' AND " + owed.unapplied('n') + ' > 0');

    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const rows = await many(
      `SELECT n.*, ${owed.unapplied('n')} AS unapplied, i.number AS invoice_number
         FROM credit_notes n LEFT JOIN invoices i ON i.id = n.invoice_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.issue_date DESC, n.created_at DESC LIMIT ${limit}`,
      args
    );
    res.json({
      creditNotes: rows.map((r) => ({
        id: r.id, number: r.number, party: r.client_name,
        invoiceNumber: r.invoice_number, issue: r.issue_date,
        total: Number(r.total_kobo), unapplied: Number(r.unapplied),
        applied: Number(r.total_kobo) - Number(r.unapplied),
        status: r.status, reason: r.reason
      })),
      outstandingCredit: rows
        .filter((r) => r.status === 'issued')
        .reduce((a, r) => a + Number(r.unapplied), 0)
    });
  } catch (err) { reply(res, err, next); }
});

// --------------------------------------------------------- online collection

// A hosted checkout URL for one invoice, from the tenant's own merchant
// account. The money goes to them; Profitna never holds it.
router.post('/invoices/:id/payment-link', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await collect.createLink(req.orgId, {
      invoiceId: req.params.id,
      amountKobo: b.amountKobo !== undefined ? Math.round(Number(b.amountKobo))
        : b.amount !== undefined ? money.toKobo(b.amount) : null,
      email: b.email, name: b.name,
      userId: req.user.id,
      provider: b.provider,
      returnBase: baseUrlOf(req) + '/api/pay/return'
    });
    await audit(req.orgId, req.user.id, 'payment_link.created', 'invoice', req.params.id, {
      provider: result.provider, amount: result.amount, reference: result.reference
    });
    res.status(201).json({
      url: result.url,
      reference: result.reference,
      provider: result.provider,
      environment: result.environment,
      amount: result.amount,
      invoice: result.invoice,
      // Said plainly, because a business sending this link to a customer
      // should know which of the two it is.
      note: result.environment === 'live'
        ? 'This link takes a real payment into your own ' + result.provider + ' account.'
        : 'This is a test link. No real money will move.'
    });
  } catch (err) { reply(res, err, next); }
});

// Links on one invoice, and whether any of them have been answered.
router.get('/invoices/:id/payment-links', requireOrg(), async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT * FROM payment_links
        WHERE organization_id = $1 AND invoice_id = $2 ORDER BY created_at DESC LIMIT 20`,
      [req.orgId, req.params.id]
    );
    res.json({
      links: rows.map((r) => ({
        id: r.id, reference: r.reference, provider: r.provider,
        amount: Number(r.amount_kobo), url: r.checkout_url, status: r.status,
        created: r.created_at, lastChecked: r.last_checked_at, lastError: r.last_error,
        paymentId: r.customer_payment_id
      }))
    });
  } catch (err) { reply(res, err, next); }
});

// Ask the provider again, now. For when a webhook was never registered, or
// was registered against the other mode's dashboard.
router.post('/payment-links/:reference/check', requireOrg('accountant'), async (req, res, next) => {
  try {
    const result = await collect.confirm({
      reference: req.params.reference, orgId: req.orgId, source: 'manual'
    });
    if (!result.known) return res.status(404).json({ error: 'No such payment reference.' });
    res.json({
      status: result.status,
      receipt: result.receipt ? await detail(req.orgId, result.receipt.id) : null,
      alreadyRecorded: Boolean(result.alreadyRecorded)
    });
  } catch (err) { reply(res, err, next); }
});

router.post('/payment-links/sweep', requireOrg('accountant'), async (req, res, next) => {
  try {
    res.json(await collect.sweep(req.orgId, { limit: Math.min(Number((req.body || {}).limit) || 25, 100) }));
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------- receivables, as a whole

// One call for the receivables screen: what is owed, how late, who by, what
// credit is outstanding and what is sitting unallocated.
router.get('/receivables', requireOrg(), async (req, res, next) => {
  try {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOf || '')) ? req.query.asOf : today();

    const [ageing, byCustomer, unallocated, credit, collection] = await Promise.all([
      accounting.receivablesAgeing(req.orgId, { asOf }),
      many(
        `SELECT i.client_name AS party, i.client_id,
                COUNT(*)::int AS invoices,
                SUM(${owed.outstanding('i')}) AS owed,
                MIN(i.due_date) AS oldest_due,
                SUM(${owed.outstanding('i')}) FILTER (WHERE i.due_date < $2) AS overdue
           FROM invoices i
          WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL
            AND ${owed.outstanding('i')} > 0
          GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 50`,
        [req.orgId, asOf]
      ),
      many(
        `SELECT c.id, c.receipt_number, c.party, c.received_on, ${owed.unallocated('c')} AS unallocated
           FROM customer_payments c
          WHERE c.organization_id = $1 AND c.status IN ('received', 'pending')
            AND ${owed.unallocated('c')} > 0
          ORDER BY c.received_on DESC LIMIT 50`,
        [req.orgId]
      ),
      many(
        `SELECT n.id, n.number, n.client_name AS party, n.issue_date, ${owed.unapplied('n')} AS unapplied
           FROM credit_notes n
          WHERE n.organization_id = $1 AND n.status = 'issued' AND ${owed.unapplied('n')} > 0
          ORDER BY n.issue_date DESC LIMIT 50`,
        [req.orgId]
      ),
      merchant.collectionState(req.orgId)
    ]);

    res.json({
      asOf,
      ageing: {
        buckets: ageing.buckets,
        total: ageing.total,
        net: ageing.net,
        ledgerReceivable: ageing.ledgerReceivable,
        unappliedCredits: ageing.unappliedCredits,
        heldInAdvance: ageing.heldInAdvance,
        reconciles: ageing.reconciles,
        difference: ageing.difference
      },
      overdue: ageing.invoices.filter((i) => i.daysOverdue > 0),
      invoices: ageing.invoices,
      byCustomer: byCustomer.map((c) => ({
        party: c.party, clientId: c.client_id, invoices: c.invoices,
        owed: Number(c.owed), overdue: Number(c.overdue || 0), oldestDue: c.oldest_due
      })),
      unallocatedPayments: unallocated.map((u) => ({
        id: u.id, number: u.receipt_number, party: u.party,
        date: u.received_on, unallocated: Number(u.unallocated)
      })),
      openCredits: credit.map((c) => ({
        id: c.id, number: c.number, party: c.party, issue: c.issue_date,
        unapplied: Number(c.unapplied)
      })),
      collection,
      // The one line that says whether the rest of this screen can be
      // trusted, rather than two figures and no verdict.
      note: ageing.reconciles
        ? 'The receivables above agree with the general ledger.'
        : 'These figures differ from the ledger by ' + money.format(ageing.difference) +
          ' because some entries have not been posted yet.'
    });
  } catch (err) { reply(res, err, next); }
});

module.exports = { router, detail, noteDetail, baseUrlOf };
