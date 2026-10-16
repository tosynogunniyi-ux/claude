// Writing to the general ledger.
//
// Every entry goes through `post()`. It is the only function that inserts a
// journal entry, so the rules below hold everywhere rather than in whichever
// call site remembered them:
//
//   An entry balances or it does not exist. The database enforces it too, but
//   failing here gives a readable message instead of a constraint violation.
//
//   An entry with a source key posts once. A retried request, a replayed
//   webhook, a backfill run twice — all collapse to one entry. Duplicate
//   revenue is the characteristic failure of accounting integrations and the
//   only reliable defence is a unique key, not a check-then-insert.
//
//   Nothing posts into a closed period. A business that has filed last year's
//   accounts should not find them moving.
//
// Corrections are reversals, never edits. A posted entry is immutable; to undo
// it you post its mirror, and both stay in the record.

const KNOWN = {
  cash: '1000',
  bank: '1010',
  receivable: '1100',
  inventory: '1200',
  gatewayClearing: '1300',
  inputVat: '1400',
  whtReceivable: '1410',
  payable: '2000',
  outputVat: '2100',
  payePayable: '2200',
  pensionPayable: '2210',
  nhfPayable: '2220',
  netSalariesPayable: '2250',
  customerDeposits: '2300',
  ownerCapital: '3000',
  retained: '3100',
  openingBalance: '3900',
  otherIncome: '4900',
  gatewayFees: '5900',
  salariesExpense: '6000',
  employerPensionExpense: '6010',
  uncategorisedExpense: '5950'
};

// Account ids by code, for one organisation, cached per call rather than per
// process: an account can be added while the server is running.
async function chart(client, orgId) {
  const { rows } = await client.query(
    'SELECT id, code, name, type FROM accounts WHERE organization_id = $1',
    [orgId]
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  return {
    byCode,
    byName,
    // A named system account. Missing one is a broken deployment, not a
    // runtime condition to paper over, so it throws.
    system(key) {
      const code = KNOWN[key];
      const row = code && byCode.get(code);
      if (!row) throw new Error('accounting: no ' + key + ' account (code ' + code + ') on this organisation');
      return row.id;
    },
    // A category by the name shown on screen, falling back to a catch-all so
    // a transaction with an unrecognised or empty category still posts rather
    // than being silently dropped out of the books.
    category(name, type) {
      const row = byName.get(String(name || '').toLowerCase());
      if (row && row.type === type) return row.id;
      const fallback = type === 'income' ? KNOWN.otherIncome : KNOWN.uncategorisedExpense;
      return byCode.get(fallback).id;
    }
  };
}

const int = (v) => Math.round(Number(v) || 0);

async function assertOpen(client, orgId, date) {
  const { rows } = await client.query(
    'SELECT books_locked_through FROM organizations WHERE id = $1',
    [orgId]
  );
  const locked = rows[0] && rows[0].books_locked_through;
  if (locked && String(date) <= String(locked)) {
    const err = new Error(
      'The books are closed up to ' + locked + ', so nothing can be posted on ' + date + '.'
    );
    err.status = 409;
    err.code = 'PERIOD_LOCKED';
    throw err;
  }
}

// The one way in.
//
// `lines` are { accountId, debit, credit, description, party } in kobo.
// Returns the entry, or the entry that already existed for this source key.
async function post(client, { orgId, date, memo, sourceType, sourceId, sourceKey, userId, lines, reversalOf }) {
  const clean = (lines || [])
    .map((l) => ({
      accountId: l.accountId,
      debit: int(l.debit),
      credit: int(l.credit),
      description: l.description || null,
      party: l.party || null
    }))
    // A zero line is not an error — a nil-rated invoice line produces one —
    // but it carries no information and the table rejects it.
    .filter((l) => l.debit !== 0 || l.credit !== 0);

  if (!clean.length) return null;

  const debits = clean.reduce((a, l) => a + l.debit, 0);
  const credits = clean.reduce((a, l) => a + l.credit, 0);
  if (debits !== credits) {
    throw new Error(
      'accounting: refusing to post an entry that does not balance — debits ' +
      debits + ' kobo, credits ' + credits + ' kobo (' + (memo || sourceKey || 'no memo') + ')'
    );
  }
  if (clean.some((l) => l.debit > 0 && l.credit > 0)) {
    throw new Error('accounting: a line is a debit or a credit, never both');
  }

  await assertOpen(client, orgId, date);

  // ON CONFLICT DO NOTHING rather than a check first: two requests arriving
  // together both see no entry, and only the unique index decides.
  const inserted = await client.query(
    `INSERT INTO journal_entries
       (organization_id, entry_date, memo, source_type, source_id, source_key, created_by, reversal_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [orgId, date, memo || null, sourceType || 'manual', sourceId || null, sourceKey || null,
      userId || null, reversalOf || null]
  );

  if (!inserted.rows.length) {
    // Already posted. Hand back what is there so the caller can carry on.
    const existing = await client.query(
      'SELECT * FROM journal_entries WHERE organization_id = $1 AND source_key = $2',
      [orgId, sourceKey]
    );
    return Object.assign({}, existing.rows[0], { alreadyPosted: true });
  }

  const entry = inserted.rows[0];
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    await client.query(
      `INSERT INTO journal_lines
         (entry_id, organization_id, account_id, line_no, debit_kobo, credit_kobo, description, party)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.id, orgId, l.accountId, i, l.debit, l.credit, l.description, l.party]
    );
  }
  return Object.assign({}, entry, { lines: clean, alreadyPosted: false });
}

// Undo, without erasing. The mirror entry carries its own date so a
// correction made in March to a January entry lands in March, which is what
// an auditor expects and what a closed January requires.
async function reverse(client, { orgId, entryId, date, memo, userId }) {
  const { rows } = await client.query(
    'SELECT * FROM journal_entries WHERE organization_id = $1 AND id = $2',
    [orgId, entryId]
  );
  const original = rows[0];
  if (!original) throw new Error('accounting: no such entry to reverse');

  const already = await client.query(
    'SELECT id FROM journal_entries WHERE organization_id = $1 AND reversal_of = $2',
    [orgId, entryId]
  );
  if (already.rows.length) return Object.assign({}, already.rows[0], { alreadyPosted: true });

  const lines = (await client.query(
    'SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [entryId]
  )).rows;

  return post(client, {
    orgId,
    date: date || new Date().toISOString().slice(0, 10),
    memo: memo || 'Reversal of ' + (original.memo || original.source_key || original.id),
    sourceType: original.source_type,
    sourceId: original.source_id,
    sourceKey: original.source_key ? original.source_key + ':reversal' : null,
    userId,
    reversalOf: entryId,
    // Debits become credits. Nothing is recalculated, so a reversal cannot
    // disagree with what it reverses.
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: Number(l.credit_kobo),
      credit: Number(l.debit_kobo),
      description: l.description,
      party: l.party
    }))
  });
}

// ----------------------------------------------------------- the posting rules

// An invoice is issued: revenue is earned and a receivable exists, whether or
// not anybody has paid. This is the entry that makes the books accrual.
async function invoiceIssued(client, { orgId, invoice, lines, totals, userId }) {
  const c = await chart(client, orgId);
  const party = invoice.client_name || invoice.party || null;
  const out = [];

  // Dr Accounts Receivable, the whole amount the customer owes.
  out.push({
    accountId: c.system('receivable'),
    debit: totals.total,
    description: 'Invoice ' + invoice.number,
    party
  });

  // Cr revenue, per line, to the account its category points at — so a P&L
  // breaks down the way the categories on screen do.
  for (const line of lines || []) {
    if (!line.net) continue;
    out.push({
      accountId: c.category(line.category || invoice.category, 'income'),
      credit: line.net,
      description: line.description || ('Invoice ' + invoice.number),
      party
    });
  }
  // An invoice with no lines is still revenue.
  if (!out.some((l) => l.credit)) {
    out.push({
      accountId: c.category(invoice.category, 'income'),
      credit: totals.net,
      description: 'Invoice ' + invoice.number,
      party
    });
  }

  // Cr Output VAT: collected on behalf of the revenue service, never revenue.
  if (totals.tax) {
    out.push({
      accountId: c.system('outputVat'),
      credit: totals.tax,
      description: 'Output VAT on ' + invoice.number,
      party
    });
  }

  return post(client, {
    orgId,
    date: invoice.issue_date || invoice.issueDate,
    memo: 'Invoice ' + invoice.number + (party ? ' to ' + party : ''),
    sourceType: 'invoice',
    sourceId: invoice.id,
    sourceKey: 'invoice:' + invoice.id + ':issue',
    userId,
    lines: out
  });
}

// Money arrives against an invoice. Revenue was recognised when it was
// issued, so this only moves the receivable into the bank — posting revenue
// again here is the classic double count.
async function invoicePaid(client, { orgId, invoice, payment, amountKobo, bankAccountId, userId, viaGateway }) {
  const c = await chart(client, orgId);
  const party = invoice.client_name || invoice.party || null;

  let debitAccount;
  if (viaGateway) {
    // The processor has the money, not the bank. It lands in clearing until
    // it settles, which is what the settlement entry then moves.
    debitAccount = c.system('gatewayClearing');
  } else if (bankAccountId) {
    const { rows } = await client.query(
      'SELECT account_id FROM bank_accounts WHERE id = $1 AND organization_id = $2',
      [bankAccountId, orgId]
    );
    debitAccount = (rows[0] && rows[0].account_id) || c.system('bank');
  } else {
    debitAccount = c.system('bank');
  }

  return post(client, {
    orgId,
    date: payment.date,
    memo: 'Payment against ' + invoice.number,
    sourceType: 'payment',
    sourceId: payment.id,
    sourceKey: 'payment:' + payment.id,
    userId,
    lines: [
      { accountId: debitAccount, debit: amountKobo, description: 'Payment ' + invoice.number, party },
      { accountId: c.system('receivable'), credit: amountKobo, description: 'Payment ' + invoice.number, party }
    ]
  });
}

// Money paid out against a bill: the mirror of invoicePaid. Settles the
// payable rather than posting the expense again, which was recognised when
// the bill was received.
async function billPaid(client, { orgId, bill, payment, amountKobo, bankAccountId, userId }) {
  const c = await chart(client, orgId);
  const party = bill.vendor_name || bill.party || null;

  let creditAccount = c.system('bank');
  if (bankAccountId) {
    const { rows } = await client.query(
      'SELECT account_id FROM bank_accounts WHERE id = $1 AND organization_id = $2',
      [bankAccountId, orgId]
    );
    if (rows[0] && rows[0].account_id) creditAccount = rows[0].account_id;
  }

  return post(client, {
    orgId,
    date: payment.date,
    memo: 'Payment of ' + bill.number,
    sourceType: 'payment',
    sourceId: payment.id,
    sourceKey: 'billpayment:' + payment.id,
    userId,
    lines: [
      { accountId: c.system('payable'), debit: amountKobo, description: 'Payment ' + bill.number, party },
      { accountId: creditAccount, credit: amountKobo, description: 'Payment ' + bill.number, party }
    ]
  });
}

// A cash-book row that is not an invoice payment: a direct sale, an expense,
// a bank charge. The cash book keeps working exactly as it did; this mirrors
// it into the ledger so the two agree.
async function cashTransaction(client, { orgId, tx, userId }) {
  const c = await chart(client, orgId);
  const amount = Math.round(Number(tx.amount) * 100);
  if (!amount) return null;

  const bank = tx.bank_account_id
    ? ((await client.query(
      'SELECT account_id FROM bank_accounts WHERE id = $1 AND organization_id = $2',
      [tx.bank_account_id, orgId]
    )).rows[0] || {}).account_id
    : null;
  const cashSide = bank || (/cash/i.test(tx.method || '') ? c.system('cash') : c.system('bank'));

  // A customer receipt. Not the same as an invoice payment, because a receipt
  // may be larger than the invoices it was put against — and the part that is
  // not against anything is money held in advance, which is a liability and
  // not a settled receivable. Split here, from the allocations as they stand,
  // so the entry says which of the two each kobo was.
  if (tx.source === 'receipt' && tx.ref_customer_payment_id) {
    return receiptEntry(client, { orgId, tx, amount, cashSide, chartOf: c, userId });
  }

  // A payment against an invoice or a bill settles a receivable or a payable.
  // It is not new revenue or a new expense — that was recognised when the
  // document was issued, and posting it again here would double the books.
  if (tx.source === 'invoice') {
    return post(client, {
      orgId, date: tx.date, memo: tx.description || 'Invoice payment',
      sourceType: 'transaction', sourceId: tx.id, sourceKey: 'transaction:' + tx.id, userId,
      lines: [
        { accountId: cashSide, debit: amount, description: tx.description, party: tx.party },
        { accountId: c.system('receivable'), credit: amount, description: tx.description, party: tx.party }
      ]
    });
  }
  if (tx.source === 'bill') {
    return post(client, {
      orgId, date: tx.date, memo: tx.description || 'Bill payment',
      sourceType: 'transaction', sourceId: tx.id, sourceKey: 'transaction:' + tx.id, userId,
      lines: [
        { accountId: c.system('payable'), debit: amount, description: tx.description, party: tx.party },
        { accountId: cashSide, credit: amount, description: tx.description, party: tx.party }
      ]
    });
  }

  const income = tx.type === 'income';
  return post(client, {
    orgId, date: tx.date, memo: tx.description || (income ? 'Receipt' : 'Payment'),
    sourceType: 'transaction', sourceId: tx.id, sourceKey: 'transaction:' + tx.id, userId,
    lines: income
      ? [
        { accountId: cashSide, debit: amount, description: tx.description, party: tx.party },
        { accountId: c.category(tx.category, 'income'), credit: amount, description: tx.description, party: tx.party }
      ]
      : [
        { accountId: c.category(tx.category, 'expense'), debit: amount, description: tx.description, party: tx.party },
        { accountId: cashSide, credit: amount, description: tx.description, party: tx.party }
      ]
  });
}

// ------------------------------------------------ receipts and credit notes

// The journal entry behind a customer receipt.
//
// Three places the money can be sitting and two things it can have settled,
// and the entry has to say which. A gateway payment that has not settled is
// in the processor's hands, not the bank's — posting it to the bank would make
// a bank reconciliation fail by exactly the amount in transit, every day,
// until somebody worked out why.
async function receiptEntry(client, { orgId, tx, amount, cashSide, chartOf, userId }) {
  const c = chartOf || (await chart(client, orgId));

  const receipt = (await client.query(
    'SELECT * FROM customer_payments WHERE id = $1 AND organization_id = $2',
    [tx.ref_customer_payment_id, orgId]
  )).rows[0];
  if (!receipt) return null;

  const allocated = Number((await client.query(
    `SELECT COALESCE(SUM(amount_kobo), 0) AS n FROM invoice_payments
      WHERE customer_payment_id = $1`,
    [receipt.id]
  )).rows[0].n);

  const inTransit = receipt.source === 'gateway' && !receipt.settled_at;
  const debitAccount = inTransit ? c.system('gatewayClearing') : cashSide;
  const party = receipt.party || tx.party || null;
  const label = receipt.receipt_number ? 'Receipt ' + receipt.receipt_number : 'Receipt';

  // Allocations cannot exceed the receipt — the database enforces it — so
  // this is never negative.
  const advance = amount - Math.min(allocated, amount);

  const lines = [
    { accountId: debitAccount, debit: amount, description: label, party }
  ];
  if (allocated > 0) {
    lines.push({
      accountId: c.system('receivable'),
      credit: Math.min(allocated, amount),
      description: label + ' — against invoices',
      party
    });
  }
  if (advance > 0) {
    // Money received before there is an invoice to put it against. A
    // liability: the business owes goods, services or a refund, not revenue.
    lines.push({
      accountId: c.system('customerDeposits'),
      credit: advance,
      description: label + ' — received in advance',
      party
    });
  }

  return post(client, {
    orgId,
    date: tx.date,
    memo: tx.description || (label + (party ? ' from ' + party : '')),
    sourceType: 'transaction',
    sourceId: tx.id,
    sourceKey: 'transaction:' + tx.id,
    userId,
    lines
  });
}

// An allocation made after the receipt was already posted. The receipt's own
// entry credited the unallocated part to Customer Deposits; putting some of it
// against an invoice moves it from there to the receivable. No cash moves, so
// there is no cash-book row and no bank account involved.
async function depositApplied(client, { orgId, allocation, invoice, userId }) {
  const c = await chart(client, orgId);
  const amount = int(allocation.amount_kobo);
  if (!amount) return null;
  const party = invoice.client_name || invoice.party || null;

  return post(client, {
    orgId,
    date: allocation.date,
    memo: 'Advance applied to ' + invoice.number,
    sourceType: 'payment',
    sourceId: allocation.id,
    // Its own namespace. 'payment:' belongs to an allocation that moved cash;
    // this one moves a liability, and the two must never collide on a key.
    sourceKey: 'allocation:' + allocation.id,
    userId,
    lines: [
      { accountId: c.system('customerDeposits'), debit: amount, description: 'Advance applied', party },
      { accountId: c.system('receivable'), credit: amount, description: 'Applied to ' + invoice.number, party }
    ]
  });
}

// A gateway payment settles into the bank. The processor's fee comes out of
// the settlement, so this is where it is recognised — the customer paid the
// invoice in full, and the fee is the business's cost of collecting it, not a
// discount the customer received.
async function paymentSettled(client, { orgId, receipt, bankAccountId, feeKobo, settledOn, userId }) {
  const c = await chart(client, orgId);
  const amount = int(receipt.amount_kobo);
  const fee = Math.max(int(feeKobo), 0);
  if (!amount) return null;
  if (fee > amount) {
    throw new Error('accounting: a gateway fee of ' + fee + ' kobo cannot exceed the ' +
      amount + ' kobo received');
  }

  let bank = c.system('bank');
  if (bankAccountId) {
    const { rows } = await client.query(
      'SELECT account_id FROM bank_accounts WHERE id = $1 AND organization_id = $2',
      [bankAccountId, orgId]
    );
    if (rows[0] && rows[0].account_id) bank = rows[0].account_id;
  }

  const lines = [
    { accountId: bank, debit: amount - fee, description: 'Gateway settlement', party: receipt.party }
  ];
  if (fee) {
    lines.push({
      accountId: c.system('gatewayFees'), debit: fee,
      description: 'Processing fee on ' + (receipt.receipt_number || receipt.provider_reference || 'payment'),
      party: receipt.provider || null
    });
  }
  lines.push({
    accountId: c.system('gatewayClearing'), credit: amount,
    description: 'Settled ' + (receipt.receipt_number || ''), party: receipt.party
  });

  return post(client, {
    orgId,
    date: settledOn || new Date().toISOString().slice(0, 10),
    memo: 'Gateway settlement — ' + (receipt.receipt_number || receipt.provider_reference || 'payment'),
    sourceType: 'payment',
    sourceId: receipt.id,
    sourceKey: 'settlement:' + receipt.id,
    userId,
    lines
  });
}

// A credit note issued: the mirror of an invoice, and the only correct way to
// change an invoice that has already been sent. Revenue is given back and the
// VAT with it, because VAT was never the business's money.
//
// Nothing is posted when it is applied to a particular invoice. The credit
// exists against the customer from the moment it is issued; which invoice it
// is set against is a fact about the receivables subledger, not about the
// general ledger, and posting it again there would credit the receivable
// twice.
async function creditNoteIssued(client, { orgId, note, lines, userId }) {
  const c = await chart(client, orgId);
  const party = note.client_name || null;
  const out = [];

  for (const line of lines || []) {
    if (!line.net) continue;
    out.push({
      accountId: c.category(line.category || note.category, 'income'),
      debit: line.net,
      description: line.description || ('Credit note ' + note.number),
      party
    });
  }
  if (!out.length) {
    out.push({
      accountId: c.category(note.category, 'income'),
      debit: int(note.subtotal_kobo),
      description: 'Credit note ' + note.number,
      party
    });
  }
  if (int(note.tax_kobo)) {
    out.push({
      accountId: c.system('outputVat'),
      debit: int(note.tax_kobo),
      description: 'VAT credited on ' + note.number,
      party
    });
  }
  out.push({
    accountId: c.system('receivable'),
    credit: int(note.total_kobo),
    description: 'Credit note ' + note.number,
    party
  });

  return post(client, {
    orgId,
    date: note.issue_date,
    memo: 'Credit note ' + note.number + (party ? ' to ' + party : ''),
    sourceType: 'credit_note',
    sourceId: note.id,
    sourceKey: 'creditnote:' + note.id + ':issue',
    userId,
    lines: out
  });
}

// A bill received: the mirror of an invoice issued.
async function billIssued(client, { orgId, bill, userId }) {
  const c = await chart(client, orgId);
  const amount = Math.round(Number(bill.total) * 100);
  if (!amount) return null;
  return post(client, {
    orgId,
    date: bill.issue_date,
    memo: 'Bill ' + bill.number + (bill.vendor_name ? ' from ' + bill.vendor_name : ''),
    sourceType: 'bill', sourceId: bill.id, sourceKey: 'bill:' + bill.id + ':issue', userId,
    lines: [
      {
        accountId: c.category(bill.category, 'expense'),
        debit: amount, description: 'Bill ' + bill.number, party: bill.vendor_name
      },
      {
        accountId: c.system('payable'),
        credit: amount, description: 'Bill ' + bill.number, party: bill.vendor_name
      }
    ]
  });
}

// The opening position: what the business had before Profitna was keeping its
// books. Balanced against equity, because the other side of an opening
// balance is not income.
async function openingBalances(client, { orgId, userId }) {
  const c = await chart(client, orgId);
  const { rows } = await client.query(
    `SELECT b.id, b.name, b.opening_balance, b.opening_date, b.account_id
       FROM bank_accounts b WHERE b.organization_id = $1 AND b.archived_at IS NULL`,
    [orgId]
  );
  const posted = [];
  for (const b of rows) {
    const amount = Math.round(Number(b.opening_balance) * 100);
    if (!amount) continue;
    const entry = await post(client, {
      orgId,
      date: b.opening_date || '2000-01-01',
      memo: 'Opening balance — ' + b.name,
      sourceType: 'opening', sourceId: b.id, sourceKey: 'opening:' + b.id, userId,
      lines: [
        { accountId: b.account_id || c.system('bank'), debit: amount, description: 'Opening balance' },
        { accountId: c.system('openingBalance'), credit: amount, description: 'Opening balance' }
      ]
    });
    if (entry) posted.push(entry);
  }
  return posted;
}

// A payroll is approved.
//
// One entry for the whole run, because that is what it is: a single monthly
// event with one expense and several liabilities, not a journal per person. A
// business with forty staff does not want forty entries a month in its
// ledger, and the payslips are where the per-person detail lives.
//
// The shape, and why each side is where it is:
//
//   Dr Salaries & Wages          gross pay — the whole cost of what staff
//                                earned, before anything was withheld.
//   Dr Employer Pension          the employer's own contribution, which is a
//                                separate cost and never comes out of pay.
//     Cr PAYE Payable            withheld from staff, owed to the state.
//     Cr Pension Payable         employee + employer, owed to the PFA.
//     Cr NHF Payable             withheld, owed to the Federal Mortgage Bank.
//     Cr Net Salaries Payable    what staff are actually owed.
//
// Nothing touches a bank account here. Approving a payroll recognises the
// cost and the debts; paying it is a separate event on a later day, and
// conflating the two is how a business books a salary run it has not yet
// sent.
async function payrollApproved(client, { orgId, run, totals, userId }) {
  const c = await chart(client, orgId);
  const period = run.period_label || (run.period_date || '').slice(0, 7);
  const lines = [
    { accountId: c.system('salariesExpense'), debit: totals.gross, description: 'Gross pay ' + period },
    { accountId: c.system('employerPensionExpense'), debit: totals.employerPension,
      description: 'Employer pension ' + period },
    { accountId: c.system('payePayable'), credit: totals.paye, description: 'PAYE withheld ' + period },
    { accountId: c.system('pensionPayable'), credit: totals.employeePension + totals.employerPension,
      description: 'Pension payable ' + period },
    { accountId: c.system('nhfPayable'), credit: totals.nhf, description: 'NHF withheld ' + period },
    { accountId: c.system('netSalariesPayable'), credit: totals.net, description: 'Net salaries ' + period }
  ];

  return post(client, {
    orgId,
    date: run.period_date,
    memo: 'Payroll ' + period,
    sourceType: 'payroll',
    sourceId: run.id,
    // Approving twice posts once. The same guarantee invoices have, and for
    // the same reason: a double-clicked button must not double the payroll.
    sourceKey: 'payroll:' + run.id + ':approve',
    userId,
    lines
  });
}

// Money actually leaves. Salaries, or a statutory remittance.
//
// Clears the liability the approval created rather than booking a new
// expense — the expense was recognised when the payroll was approved, and
// booking it again here is the double count this function exists to avoid.
async function payrollPaid(client, { orgId, run, payment, bankAccountId, userId }) {
  const c = await chart(client, orgId);
  const period = run.period_label || (run.period_date || '').slice(0, 7);
  const LIABILITY = {
    salaries: 'netSalariesPayable',
    paye: 'payePayable',
    pension: 'pensionPayable',
    nhf: 'nhfPayable'
  };
  const key = LIABILITY[payment.kind];
  if (!key) {
    // 'other' has nowhere specific to go, and guessing would put a
    // remittance in the wrong liability. Say so rather than post it somewhere
    // plausible.
    const err = new Error('A payment of kind "' + payment.kind + '" cannot be posted automatically.');
    err.status = 422;
    throw err;
  }

  const bank = bankAccountId
    ? await require('./accounts').ensureBankAccount(client, orgId, bankAccountId)
    : c.system('bank');

  const WORDS = { salaries: 'Salaries paid', paye: 'PAYE remitted', pension: 'Pension remitted',
    nhf: 'NHF remitted' };

  return post(client, {
    orgId,
    date: payment.paid_on,
    memo: WORDS[payment.kind] + ' ' + period,
    sourceType: 'payroll',
    sourceId: payment.id,
    sourceKey: 'payroll:payment:' + payment.id,
    userId,
    lines: [
      { accountId: c.system(key), debit: payment.amount_kobo, description: WORDS[payment.kind] + ' ' + period },
      { accountId: bank, credit: payment.amount_kobo, description: WORDS[payment.kind] + ' ' + period }
    ]
  });
}

module.exports = {
  post, reverse, chart, KNOWN,
  invoiceIssued, invoicePaid, cashTransaction, billIssued, billPaid, openingBalances,
  receiptEntry, depositApplied, paymentSettled, creditNoteIssued,
  payrollApproved, payrollPaid
};
