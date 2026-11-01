// The chart of accounts, for one organisation.
//
// Migration 009 built this for every organisation that existed when it ran.
// This is the same thing for the ones created afterwards, and it is the same
// list — defined once, here, so a business that signed up yesterday and one
// that signs up tomorrow get identical books.
//
// `ensure` is idempotent and safe to call on an organisation that already has
// its accounts, which is what makes it usable as a repair as well as a seed.

// Every account the posting rules name directly. Changing a code here changes
// where money lands, so each is matched by a constant in post.js and neither
// list may move without the other.
const SYSTEM = [
  ['1000', 'Cash on Hand', 'asset', 'cash'],
  ['1010', 'Bank', 'asset', 'cash'],
  ['1100', 'Accounts Receivable', 'asset', 'receivable'],
  ['1200', 'Inventory', 'asset', 'inventory'],
  ['1300', 'Payment Gateway Clearing', 'asset', 'clearing'],
  ['1400', 'Input VAT Receivable', 'asset', 'tax'],
  ['1410', 'Withholding Tax Receivable', 'asset', 'tax'],
  ['1500', 'Fixed Assets', 'asset', 'fixed'],
  ['2000', 'Accounts Payable', 'liability', 'payable'],
  ['2100', 'Output VAT Payable', 'liability', 'tax'],
  // Payroll. Four separate liabilities rather than one "payroll payable",
  // because each is owed to a different body on a different deadline — PAYE
  // to a state revenue service, pension to a PFA, NHF to the Federal Mortgage
  // Bank — and a single pooled figure cannot tell you which remittance is
  // late.
  ['2200', 'PAYE Payable', 'liability', 'tax'],
  ['2210', 'Pension Payable', 'liability', 'payroll'],
  ['2220', 'NHF Payable', 'liability', 'payroll'],
  ['2250', 'Net Salaries Payable', 'liability', 'payroll'],
  ['2300', 'Customer Deposits', 'liability', 'deposit'],
  ['3000', 'Owner Capital', 'equity', 'capital'],
  ['3100', 'Retained Earnings', 'equity', 'retained'],
  ['3900', 'Opening Balance Equity', 'equity', 'opening'],
  ['4900', 'Other Income', 'income', 'other'],
  ['5900', 'Gateway Processing Fees', 'expense', 'finance'],
  // Gross pay and the employer's own contribution are different costs and a
  // business needs to see them apart: one is what staff are paid, the other
  // is what employing them costs on top.
  ['6000', 'Salaries & Wages', 'expense', 'payroll'],
  ['6010', 'Employer Pension Contribution', 'expense', 'payroll'],
  ['5950', 'Uncategorised Expense', 'expense', 'other']
];

async function ensure(client, orgId) {
  for (const [code, name, type, subtype] of SYSTEM) {
    await client.query(
      `INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT DO NOTHING`,
      [orgId, code, name, type, subtype]
    );
  }

  // One account per category on the chart the business actually sees, so a
  // P&L breaks down the way its own screens do. A category whose name already
  // belongs to a system account — "Other Income" is in the default list —
  // points at that one rather than creating a second with the same name.
  for (const [table, type, series] of [
    ['income_categories', 'income', '4'],
    ['expense_categories', 'expense', '5']
  ]) {
    await client.query(
      `INSERT INTO accounts (organization_id, code, name, type, subtype)
       SELECT $1,
              $2 || LPAD((100 + ROW_NUMBER() OVER (ORDER BY c.sort_order, c.name))::text, 3, '0'),
              c.name, $3, 'operating'
         FROM ${table} c
        WHERE c.organization_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM accounts a
             WHERE a.organization_id = $1 AND a.type = $3 AND lower(a.name) = lower(c.name))
       ON CONFLICT DO NOTHING`,
      [orgId, series, type]
    );
    await client.query(
      `UPDATE ${table} c SET account_id = a.id
         FROM accounts a
        WHERE a.organization_id = c.organization_id
          AND lower(a.name) = lower(c.name) AND a.type = $2
          AND c.organization_id = $1 AND c.account_id IS NULL`,
      [orgId, type]
    );
  }

  return accountsFor(client, orgId);
}

// A ledger account for one of the business's own bank accounts, so a
// statement reconciles against a single account rather than a pooled one.
async function ensureBankAccount(client, orgId, bankAccountId) {
  const { rows } = await client.query(
    'SELECT id, name, account_id FROM bank_accounts WHERE id = $1 AND organization_id = $2',
    [bankAccountId, orgId]
  );
  const bank = rows[0];
  if (!bank || bank.account_id) return bank ? bank.account_id : null;

  const next = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(code FROM 3)::int), 20) + 1 AS n
       FROM accounts WHERE organization_id = $1 AND code ~ '^10[0-9][0-9]$' AND code <> '1000' AND code <> '1010'`,
    [orgId]
  );
  const code = '10' + String(next.rows[0].n).padStart(2, '0');

  const created = await client.query(
    `INSERT INTO accounts (organization_id, code, name, type, subtype)
     VALUES ($1, $2, $3, 'asset', 'cash')
     ON CONFLICT DO NOTHING RETURNING id`,
    [orgId, code, bank.name]
  );
  const accountId = created.rows.length
    ? created.rows[0].id
    : (await client.query(
      "SELECT id FROM accounts WHERE organization_id = $1 AND lower(name) = lower($2) AND type = 'asset'",
      [orgId, bank.name]
    )).rows[0].id;

  await client.query('UPDATE bank_accounts SET account_id = $2 WHERE id = $1', [bankAccountId, accountId]);
  return accountId;
}

function accountsFor(client, orgId) {
  return client.query(
    'SELECT id, code, name, type, subtype, is_system FROM accounts WHERE organization_id = $1 ORDER BY code',
    [orgId]
  ).then((r) => r.rows);
}

module.exports = { ensure, ensureBankAccount, accountsFor, SYSTEM };
