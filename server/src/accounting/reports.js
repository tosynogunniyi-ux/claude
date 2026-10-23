// Reading the general ledger.
//
// Everything here is derived from journal lines at read time. There is no
// stored balance column anywhere, for the same reason document status is
// derived: a cached total is correct only until the next thing that should
// have updated it did not.
//
// All figures are integer kobo.

const { many, one } = require('../db');
const owed = require('../invoicing/outstanding');

// Which way an account's balance normally runs. Assets and expenses increase
// on the debit side; liabilities, equity and income on the credit. Getting
// this wrong is how a balance sheet ends up with negative revenue.
const NORMAL = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', income: 'credit' };

const signed = (type, debit, credit) =>
  (NORMAL[type] === 'debit' ? debit - credit : credit - debit);

function window(from, to, params) {
  const clauses = [];
  if (from) { params.push(from); clauses.push('e.entry_date >= $' + params.length); }
  if (to) { params.push(to); clauses.push('e.entry_date <= $' + params.length); }
  return clauses.length ? ' AND ' + clauses.join(' AND ') : '';
}

// Every account with movement, and what it nets to. The sum of debits must
// equal the sum of credits — if it does not, something has gone wrong that no
// other report will tell you about, so this is the one to look at first.
async function trialBalance(orgId, { from, to } = {}) {
  const params = [orgId];
  const rows = await many(
    `SELECT a.id, a.code, a.name, a.type, a.subtype,
            COALESCE(SUM(l.debit_kobo), 0)  AS debit,
            COALESCE(SUM(l.credit_kobo), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id ${window(from, to, params)}
      WHERE a.organization_id = $1
      GROUP BY a.id, a.code, a.name, a.type, a.subtype
      HAVING COALESCE(SUM(l.debit_kobo), 0) <> 0 OR COALESCE(SUM(l.credit_kobo), 0) <> 0
      ORDER BY a.code`,
    params
  );

  const accounts = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    return {
      id: r.id, code: r.code, name: r.name, type: r.type, subtype: r.subtype,
      debit, credit,
      balance: signed(r.type, debit, credit)
    };
  });

  const debits = accounts.reduce((a, x) => a + x.debit, 0);
  const credits = accounts.reduce((a, x) => a + x.credit, 0);
  return {
    accounts,
    debits,
    credits,
    difference: debits - credits,
    balanced: debits === credits
  };
}

// Profit and loss, on the accrual basis: revenue when invoiced, costs when
// incurred. The cash-basis figures the rest of the product shows come from
// the cash book and are deliberately left alone.
async function profitAndLoss(orgId, { from, to } = {}) {
  const tb = await trialBalance(orgId, { from, to });
  const pick = (type) => tb.accounts.filter((a) => a.type === type)
    .map((a) => ({ code: a.code, name: a.name, amount: a.balance }))
    .filter((a) => a.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  const income = pick('income');
  const expenses = pick('expense');
  const totalIncome = income.reduce((a, x) => a + x.amount, 0);
  const totalExpense = expenses.reduce((a, x) => a + x.amount, 0);

  return {
    from: from || null,
    to: to || null,
    basis: 'accrual',
    income,
    expenses,
    totalIncome,
    totalExpense,
    net: totalIncome - totalExpense
  };
}

// The balance sheet. Retained earnings are derived from income less expenses
// across all time rather than stored, so it balances by construction — and if
// it does not, the ledger itself is wrong and should be looked at.
async function balanceSheet(orgId, { asOf } = {}) {
  const tb = await trialBalance(orgId, { to: asOf });
  const group = (type) => tb.accounts.filter((a) => a.type === type)
    .map((a) => ({ code: a.code, name: a.name, subtype: a.subtype, amount: a.balance }))
    .filter((a) => a.amount !== 0);

  const assets = group('asset');
  const liabilities = group('liability');
  const equity = group('equity');

  const totalAssets = assets.reduce((a, x) => a + x.amount, 0);
  const totalLiabilities = liabilities.reduce((a, x) => a + x.amount, 0);
  const postedEquity = equity.reduce((a, x) => a + x.amount, 0);

  const earned = tb.accounts
    .filter((a) => a.type === 'income' || a.type === 'expense')
    .reduce((a, x) => a + (x.type === 'income' ? x.balance : -x.balance), 0);

  return {
    asOf: asOf || null,
    assets,
    liabilities,
    equity,
    retainedEarnings: earned,
    totalAssets,
    totalLiabilities,
    totalEquity: postedEquity + earned,
    // Assets = liabilities + equity. The one line that says whether any of
    // the rest can be trusted.
    balanced: totalAssets === totalLiabilities + postedEquity + earned,
    difference: totalAssets - (totalLiabilities + postedEquity + earned)
  };
}

// What customers owe, by how late it is. Read from the ledger's receivable
// account rather than from invoice rows, so it reconciles with the balance
// sheet by construction.
async function receivablesAgeing(orgId, { asOf } = {}) {
  const on = asOf || new Date().toISOString().slice(0, 10);
  const rows = await many(
    `SELECT i.id, i.number, i.client_name AS party, i.due_date,
            i.total_kobo AS total,
            ${owed.paid('i')} AS paid,
            ${owed.credited('i')} AS credited
       FROM invoices i
      WHERE i.organization_id = $1
        AND i.base_status <> 'draft'
        AND i.voided_at IS NULL
        AND i.issue_date <= $2`,
    [orgId, on]
  );

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const open = [];
  // Every invoice's balance, overpaid ones included. The ageing buckets only
  // hold what is actually owed, but the figure that has to agree with the
  // ledger is the net of all of them — an overpaid invoice is a credit on the
  // receivable account and dropping it would make the check fail for a reason
  // that is not a fault.
  let net = 0;
  for (const r of rows) {
    const outstanding = Number(r.total) - Number(r.paid) - Number(r.credited);
    net += outstanding;
    if (outstanding <= 0) continue;
    const days = Math.floor((new Date(on) - new Date(r.due_date)) / 86400000);
    const bucket = days <= 0 ? 'current'
      : days <= 30 ? 'd1_30'
        : days <= 60 ? 'd31_60'
          : days <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket] += outstanding;
    open.push({
      id: r.id, number: r.number, party: r.party, due: r.due_date,
      outstanding, daysOverdue: Math.max(0, days), bucket
    });
  }

  const total = Object.values(buckets).reduce((a, x) => a + x, 0);

  // The ledger's own view of the same number, and the two things that make it
  // legitimately differ from the invoice table.
  //
  // Issuing a credit note credits the receivable immediately; setting it
  // against a particular invoice is a fact about the subledger and posts
  // nothing. So a credit that has been issued and not yet applied is in the
  // ledger's figure and not in the invoices' — which is not a fault, it is a
  // customer with money on account.
  //
  // Money received in advance is not here at all: it credits Customer
  // Deposits, a liability, and never touches the receivable.
  const [ledger, credits, deposits] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(l.debit_kobo - l.credit_kobo), 0) AS balance
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.organization_id = $1 AND a.code = '1100' AND e.entry_date <= $2`,
      [orgId, on]
    ),
    one(
      `SELECT COALESCE(SUM(${owed.unapplied('n')}), 0) AS unapplied
         FROM credit_notes n
        WHERE n.organization_id = $1 AND n.status = 'issued' AND n.issue_date <= $2`,
      [orgId, on]
    ),
    one(
      `SELECT COALESCE(SUM(${owed.unallocated('c')}), 0) AS held
         FROM customer_payments c
        WHERE c.organization_id = $1 AND c.received_on <= $2
          AND c.status IN ('received', 'pending')`,
      [orgId, on]
    )
  ]);

  const unappliedCredits = Number(credits.unapplied);
  const expected = net - unappliedCredits;

  return {
    asOf: on,
    buckets,
    total,
    net,
    unappliedCredits,
    // Money taken that is not against any invoice yet. A liability, shown here
    // because this is the screen where somebody is looking for it.
    heldInAdvance: Number(deposits.held),
    invoices: open.sort((a, b) => b.daysOverdue - a.daysOverdue),
    ledgerReceivable: Number(ledger.balance),
    reconciles: Number(ledger.balance) === expected,
    difference: Number(ledger.balance) - expected
  };
}

// One account's movements, for drilling in from any of the above.
async function ledgerFor(orgId, accountId, { from, to, limit } = {}) {
  const params = [orgId, accountId];
  const rows = await many(
    `SELECT e.entry_date, e.memo, e.source_type, e.source_id,
            l.debit_kobo AS debit, l.credit_kobo AS credit, l.description, l.party
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.organization_id = $1 AND l.account_id = $2 ${window(from, to, params)}
      ORDER BY e.entry_date, e.created_at
      LIMIT ${Math.min(Number(limit) || 500, 2000)}`,
    params
  );
  let running = 0;
  return rows.map((r) => {
    running += Number(r.debit) - Number(r.credit);
    return {
      date: r.entry_date, memo: r.memo, description: r.description, party: r.party,
      sourceType: r.source_type, sourceId: r.source_id,
      debit: Number(r.debit), credit: Number(r.credit), running
    };
  });
}

// Is the ledger keeping up with the cash book? A number anybody can check,
// rather than a promise that the two are in step.
async function coverage(orgId) {
  const row = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM transactions t WHERE t.organization_id = $1) AS transactions,
       (SELECT COUNT(*)::int FROM transactions t
         WHERE t.organization_id = $1
           AND NOT EXISTS (SELECT 1 FROM journal_entries j
                            WHERE j.organization_id = $1 AND j.source_key = 'transaction:' || t.id)) AS unposted_transactions,
       (SELECT COUNT(*)::int FROM invoices i WHERE i.organization_id = $1 AND i.base_status <> 'draft') AS invoices,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.organization_id = $1 AND i.base_status <> 'draft'
           AND NOT EXISTS (SELECT 1 FROM journal_entries j
                            WHERE j.organization_id = $1 AND j.source_key = 'invoice:' || i.id || ':issue')) AS unposted_invoices,
       (SELECT COUNT(*)::int FROM journal_entries j WHERE j.organization_id = $1) AS entries`,
    [orgId]
  );
  return {
    transactions: row.transactions,
    unpostedTransactions: row.unposted_transactions,
    invoices: row.invoices,
    unpostedInvoices: row.unposted_invoices,
    entries: row.entries,
    complete: row.unposted_transactions === 0 && row.unposted_invoices === 0
  };
}

module.exports = {
  trialBalance, profitAndLoss, balanceSheet, receivablesAgeing, ledgerFor, coverage, NORMAL
};
