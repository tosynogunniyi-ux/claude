// Money arriving, and what it was for.
//
// The thing this module exists to get right is that those are two separate
// facts. A customer sends ₦500,000 against four invoices and a deposit on a
// fifth that has not been raised yet. Before this release Profitna could
// record "a payment of ₦120,000 against invoice 7" and nothing else, so that
// transfer had to be typed in as five payments that never existed, or as one
// payment against one invoice with the rest lost.
//
// So: one receipt, many allocations. The receipt is the money — it has a
// date, a method, a bank account and a receipt number the customer can be
// given. The allocations say which invoices it settled. They do not have to
// add up to it, and the part that does not is money held in advance, which is
// a liability until there is an invoice to put it against.
//
// Everything here takes a client inside an open transaction, because a
// receipt, its allocations, its cash-book row and its journal entry are one
// event. Three of the four is a corrupted set of books.

const money = require('../money');
const numbering = require('../invoicing/numbering');
const gl = require('../accounting/post');
const owed = require('../invoicing/outstanding');

// What the customer_payments row records, and what the cash book calls the
// same thing. The cash book's names are the ones already on screen and in
// eight months of existing rows; these are the stable keys. Both are kept
// rather than one being derived, because changing a display label should not
// change what a stored row means.
const METHODS = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  pos: 'POS',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Bank transfer'
};
const METHOD_KEYS = Object.keys(METHODS);

function methodKey(value) {
  const raw = String(value || '').trim();
  if (METHODS[raw.toLowerCase()]) return raw.toLowerCase();
  const found = METHOD_KEYS.find((k) => METHODS[k].toLowerCase() === raw.toLowerCase());
  return found || 'bank_transfer';
}

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// --------------------------------------------------------------- allocating

// One invoice, locked, with what it still owes. The lock is the whole point:
// two payments allocated against the same invoice at the same moment would
// both read the same outstanding figure and both be allowed, and the invoice
// would end up overpaid by exactly the smaller of them.
async function lockInvoice(client, orgId, invoiceId) {
  const { rows } = await client.query(
    `SELECT i.*, ${owed.paid('i')} AS paid_kobo, ${owed.credited('i')} AS credited_kobo
       FROM invoices i
      WHERE i.organization_id = $1 AND i.id = $2
      FOR UPDATE OF i`,
    [orgId, invoiceId]
  );
  const invoice = rows[0];
  if (!invoice) throw fail(404, 'No such invoice.');
  if (invoice.voided_at) throw fail(409, 'Invoice ' + invoice.number + ' has been voided.');
  if (invoice.base_status === 'draft') {
    throw fail(409, 'Invoice ' + invoice.number + ' is still a draft. Issue it before recording a payment.');
  }
  invoice.outstanding = Number(invoice.total_kobo) - Number(invoice.paid_kobo) - Number(invoice.credited_kobo);
  return invoice;
}

// Turns what the request asked for into allocations that are known to fit.
//
// Refusing an over-allocation rather than letting it through is deliberate.
// An invoice recorded as paid ₦150,000 when it was for ₦100,000 reads as a
// settled invoice and a customer who owes nothing, when what actually
// happened is a customer with ₦50,000 on account. The second is recoverable;
// the first is found months later by the customer.
async function resolveAllocations(client, orgId, requested, receiptKobo) {
  const out = [];
  let running = 0;

  for (const item of requested || []) {
    const amount = item.amountKobo !== undefined ? Math.round(Number(item.amountKobo)) : money.toKobo(item.amount);
    if (!item.invoiceId) throw fail(400, 'An allocation has to say which invoice it is against.');
    if (!amount) continue;
    if (amount < 0) throw fail(400, 'An allocation cannot be negative. Use a credit note to reduce an invoice.');

    const invoice = await lockInvoice(client, orgId, item.invoiceId);
    if (amount > invoice.outstanding) {
      throw fail(400,
        'Invoice ' + invoice.number + ' only has ' + money.format(invoice.outstanding) +
        ' outstanding, so ' + money.format(amount) + ' cannot be put against it. ' +
        'Record the excess as money on account and allocate it later.');
    }
    running += amount;
    if (running > receiptKobo) {
      throw fail(400,
        'The allocations add up to ' + money.format(running) + ', which is more than the ' +
        money.format(receiptKobo) + ' received.');
    }
    out.push({ invoice, amount });
  }
  return out;
}

// What a payment from this customer would most sensibly settle: the oldest
// invoices first, until the money runs out. A suggestion the person can
// change, never applied on its own — oldest-first is the convention, not a
// rule, and a customer who said "this is for invoice 12" meant invoice 12.
async function suggest(client, orgId, { party, clientId, amountKobo }) {
  const args = [orgId];
  let scope = '';
  if (clientId) { args.push(clientId); scope = 'AND i.client_id = $' + args.length; }
  else if (party) { args.push(String(party)); scope = 'AND lower(i.client_name) = lower($' + args.length + ')'; }

  const { rows } = await client.query(
    `SELECT i.id, i.number, i.issue_date, i.due_date, i.total_kobo,
            ${owed.outstanding('i')} AS outstanding
       FROM invoices i
      WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL ${scope}
        AND ${owed.outstanding('i')} > 0
      ORDER BY i.due_date, i.issue_date, i.created_at`,
    args
  );

  let left = Math.max(Math.round(Number(amountKobo) || 0), 0);
  return rows.map((r) => {
    const take = Math.min(left, Number(r.outstanding));
    left -= take;
    return {
      invoiceId: r.id,
      number: r.number,
      issue: r.issue_date,
      due: r.due_date,
      total: Number(r.total_kobo),
      outstanding: Number(r.outstanding),
      suggested: take
    };
  });
}

// ----------------------------------------------------------------- recording

// The one way a customer payment is written.
//
// `source` is 'manual' when a person typed it in and 'gateway' when a
// provider confirmed it. Both are real; the difference is recorded rather
// than inferred, because when a figure is disputed the first question is how
// it was established.
async function record(client, {
  orgId, userId, bookType,
  party, clientId, receivedOn, amountKobo, method, bankAccountId,
  reference, notes, allocations,
  source = 'manual', provider = null, providerReference = null,
  feeKobo = 0, status = 'received', settledAt = null, currency = 'NGN'
}) {
  const amount = Math.round(Number(amountKobo) || 0);
  if (amount <= 0) throw fail(400, 'Enter how much was received.');
  const name = String(party || '').trim();
  if (!name) throw fail(400, 'Say who the payment came from.');
  const on = isDate(receivedOn) ? receivedOn : today();
  const key = methodKey(method);

  // A replayed webhook, a retried verify and a double-clicked button are the
  // same event. The unique index decides, not a check first — two of them
  // arriving together would both see nothing and both insert.
  if (providerReference) {
    const existing = await client.query(
      `SELECT * FROM customer_payments
        WHERE organization_id = $1 AND provider = $2 AND provider_reference = $3`,
      [orgId, provider, String(providerReference)]
    );
    if (existing.rows.length) {
      return { receipt: existing.rows[0], allocations: [], alreadyRecorded: true };
    }
  }

  const planned = await resolveAllocations(client, orgId, allocations, amount);

  const receiptNumber = (await numbering.allocate(client, orgId, 'receipt', on)).number;

  let receipt;
  try {
    receipt = (await client.query(
      `INSERT INTO customer_payments
         (organization_id, party, client_id, received_on, amount_kobo, currency, method,
          source, provider, provider_reference, reference, bank_account_id, receipt_number,
          notes, status, settled_at, fee_kobo, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [orgId, name, clientId || null, on, amount, currency, key,
        source, provider, providerReference ? String(providerReference) : null,
        String(reference || '').trim() || null, bankAccountId || null, receiptNumber,
        String(notes || '').trim() || null, status, settledAt, Math.max(Math.round(Number(feeKobo) || 0), 0),
        userId || null]
    )).rows[0];
  } catch (err) {
    // The unique index caught a race the check above could not see.
    if (err.code === '23505' && providerReference) {
      const existing = await client.query(
        `SELECT * FROM customer_payments
          WHERE organization_id = $1 AND provider = $2 AND provider_reference = $3`,
        [orgId, provider, String(providerReference)]
      );
      if (existing.rows.length) {
        return { receipt: existing.rows[0], allocations: [], alreadyRecorded: true };
      }
    }
    throw err;
  }

  const written = [];
  for (const item of planned) {
    const row = (await client.query(
      `INSERT INTO invoice_payments
         (invoice_id, organization_id, customer_payment_id, amount_kobo, date, method)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [item.invoice.id, orgId, receipt.id, item.amount, on, METHODS[key]]
    )).rows[0];
    written.push({ allocation: row, invoice: item.invoice });
  }

  // The cash book. A customer payment that is not in it cannot be matched
  // against a bank statement line, and a figure that appears in the
  // receivables report and nowhere a statement can reach it is a figure
  // somebody will spend an afternoon looking for.
  //
  // A gateway payment that has not settled deliberately carries no bank
  // account: the money is with the processor, and showing it on the bank
  // would make every reconciliation fail by the amount in transit.
  const inTransit = source === 'gateway' && !settledAt;
  const cashRow = (await client.query(
    `INSERT INTO transactions
       (organization_id, type, date, amount, category, fund, party, description, method,
        bank_account_id, source, ref_customer_payment_id, created_by)
     VALUES ($1,'income',$2,$3,$4,$5,$6,$7,$8,$9,'receipt',$10,$11)
     RETURNING *`,
    [orgId, on, money.toNaira(amount),
      bookType === 'church' ? 'Donations & Grants' : 'Product Sales',
      bookType === 'church' ? 'General Fund' : null,
      name,
      'Receipt ' + receiptNumber + (written.length
        ? ' — ' + written.map((w) => w.invoice.number).join(', ')
        : ' — on account'),
      METHODS[key],
      inTransit ? null : (bankAccountId || null),
      receipt.id, userId || null]
  )).rows[0];

  // And into the ledger, from the cash-book row, under the same source key
  // the background pass would have used — so this and the backfill can never
  // both post the same receipt.
  await gl.cashTransaction(client, { orgId, tx: cashRow, userId });

  return {
    receipt,
    allocations: written.map((w) => w.allocation),
    invoices: written.map((w) => w.invoice),
    transaction: cashRow,
    alreadyRecorded: false
  };
}

// Putting money already received against an invoice. The receipt's own entry
// credited the unallocated part to Customer Deposits; this moves it onto the
// receivable, which is a journal entry of its own and no cash movement.
async function allocate(client, { orgId, userId, receiptId, allocations }) {
  const { rows } = await client.query(
    `SELECT c.*, ${owed.unallocated('c')} AS unallocated
       FROM customer_payments c WHERE c.organization_id = $1 AND c.id = $2 FOR UPDATE OF c`,
    [orgId, receiptId]
  );
  const receipt = rows[0];
  if (!receipt) throw fail(404, 'No such payment.');
  if (receipt.status === 'reversed' || receipt.status === 'failed') {
    throw fail(409, 'That payment was ' + receipt.status + ' and cannot be allocated.');
  }

  const available = Number(receipt.unallocated);
  if (available <= 0) throw fail(409, 'All of that payment has already been allocated.');

  const planned = await resolveAllocations(client, orgId, allocations, available);
  if (!planned.length) throw fail(400, 'Choose at least one invoice.');

  const written = [];
  for (const item of planned) {
    const row = (await client.query(
      `INSERT INTO invoice_payments
         (invoice_id, organization_id, customer_payment_id, amount_kobo, date, method)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [item.invoice.id, orgId, receipt.id, item.amount,
        isDate(receipt.received_on) ? receipt.received_on : today(), METHODS[methodKey(receipt.method)]]
    )).rows[0];
    await gl.depositApplied(client, { orgId, allocation: row, invoice: item.invoice, userId });
    written.push({ allocation: row, invoice: item.invoice });
  }

  return { receipt, allocations: written.map((w) => w.allocation), invoices: written.map((w) => w.invoice) };
}

// A gateway payment reaches the bank. Until this happens the money is in the
// processor's clearing account, which is where it actually is.
async function settle(client, { orgId, userId, receiptId, bankAccountId, feeKobo, settledOn }) {
  const { rows } = await client.query(
    'SELECT * FROM customer_payments WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, receiptId]
  );
  const receipt = rows[0];
  if (!receipt) throw fail(404, 'No such payment.');
  if (receipt.source !== 'gateway') {
    throw fail(409, 'Only a gateway payment settles — this one was received directly.');
  }
  if (receipt.settled_at) throw fail(409, 'That payment has already been settled.');

  const fee = feeKobo === undefined || feeKobo === null
    ? Number(receipt.fee_kobo) : Math.max(Math.round(Number(feeKobo) || 0), 0);
  const on = isDate(settledOn) ? settledOn : today();

  const updated = (await client.query(
    `UPDATE customer_payments
        SET settled_at = now(), fee_kobo = $3, bank_account_id = COALESCE($4, bank_account_id),
            status = 'received'
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, receiptId, fee, bankAccountId || null]
  )).rows[0];

  // The cash-book row deliberately had no bank account while the money was in
  // transit. Now it has one, so a statement line can be matched to it.
  await client.query(
    `UPDATE transactions SET bank_account_id = COALESCE($3, bank_account_id)
      WHERE organization_id = $1 AND ref_customer_payment_id = $2`,
    [orgId, receiptId, bankAccountId || null]
  );

  await gl.paymentSettled(client, {
    orgId, receipt: updated, bankAccountId: bankAccountId || updated.bank_account_id,
    feeKobo: fee, settledOn: on, userId
  });

  return updated;
}

// Undoing a receipt. Not a delete: the reversal is posted and both stay in
// the record, because a receipt that was sent to a customer and then
// vanished is indistinguishable from one that was never issued.
async function reverse(client, { orgId, userId, receiptId, reason, on }) {
  const { rows } = await client.query(
    'SELECT * FROM customer_payments WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, receiptId]
  );
  const receipt = rows[0];
  if (!receipt) throw fail(404, 'No such payment.');
  if (receipt.status === 'reversed') throw fail(409, 'That payment has already been reversed.');

  const date = isDate(on) ? on : today();

  // Every entry this receipt caused, named by its key rather than found by a
  // pattern: the cash-book row that recorded the money, the settlement that
  // moved it out of clearing, and one per allocation made after the fact.
  // Anything matched more loosely than this would eventually reverse somebody
  // else's entry.
  const keys = ['settlement:' + receiptId];
  for (const t of (await client.query(
    'SELECT id FROM transactions WHERE organization_id = $1 AND ref_customer_payment_id = $2',
    [orgId, receiptId]
  )).rows) keys.push('transaction:' + t.id);
  for (const a of (await client.query(
    'SELECT id FROM invoice_payments WHERE organization_id = $1 AND customer_payment_id = $2',
    [orgId, receiptId]
  )).rows) keys.push('allocation:' + a.id);

  const entries = (await client.query(
    `SELECT id, source_key FROM journal_entries
      WHERE organization_id = $1 AND source_key = ANY($2) AND reversal_of IS NULL`,
    [orgId, keys]
  )).rows;

  for (const entry of entries) {
    await gl.reverse(client, {
      orgId, entryId: entry.id, date, userId,
      memo: 'Reversal of ' + (receipt.receipt_number || 'receipt') + (reason ? ' — ' + reason : '')
    });
  }

  // The allocations go, so the invoices they settled are open again. The
  // receipt row stays, marked, so the number is not reused and the history
  // shows what happened.
  await client.query('DELETE FROM invoice_payments WHERE customer_payment_id = $1', [receiptId]);

  return (await client.query(
    `UPDATE customer_payments SET status = 'reversed', notes =
        CASE WHEN $3 = '' THEN notes
             ELSE COALESCE(notes || E'\\n', '') || 'Reversed: ' || $3 END
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, receiptId, String(reason || '').trim()]
  )).rows[0];
}

module.exports = {
  record, allocate, settle, reverse, suggest,
  resolveAllocations, lockInvoice, METHODS, METHOD_KEYS, methodKey
};
