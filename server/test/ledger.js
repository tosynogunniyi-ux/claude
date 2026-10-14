// Does the general ledger hold?
//   npm run test:ledger
//
// The question an accounting test has to answer is not "did it write rows"
// but "do the rows add up, and do they still add up after the things that
// normally break them": a retried request, a replayed webhook, a payment
// against an invoice, a reversal, a closed period.
//
// Every assertion here is against the real database, because the balance rule
// is enforced by a deferred constraint trigger and a test that stubbed the
// database would be testing something else.

require('dotenv').config();
const { pool, one, many, query, tx } = require('../src/db');
const money = require('../src/money');
const post = require('../src/accounting/post');
const reports = require('../src/accounting/reports');
const backfill = require('../src/accounting/backfill');
const { seedChartOfAccounts } = require('../src/defaults');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// A fresh organisation with the same chart every real one gets.
async function makeOrg(tag) {
  const org = await one(
    "INSERT INTO organizations (name, vat_registered, vat_rate) VALUES ($1, true, 7.5) RETURNING *",
    ['Ledger ' + tag]
  );
  await tx(async (client) => {
    await seedChartOfAccounts(client, org.id, 'sme');
    // Accounts for the categories just seeded, the same way migration 009
    // does for everyone else.
    await client.query(
      `INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
       SELECT $1, a.code, a.name, a.type, a.subtype, true FROM (VALUES
         ('1000','Cash on Hand','asset','cash'), ('1010','Bank','asset','cash'),
         ('1100','Accounts Receivable','asset','receivable'), ('1200','Inventory','asset','inventory'),
         ('1300','Payment Gateway Clearing','asset','clearing'), ('1400','Input VAT Receivable','asset','tax'),
         ('1410','Withholding Tax Receivable','asset','tax'), ('1500','Fixed Assets','asset','fixed'),
         ('2000','Accounts Payable','liability','payable'), ('2100','Output VAT Payable','liability','tax'),
         ('2300','Customer Deposits','liability','deposit'), ('3000','Owner Capital','equity','capital'),
         ('3100','Retained Earnings','equity','retained'), ('3900','Opening Balance Equity','equity','opening'),
         ('4900','Other Income','income','other'), ('5900','Gateway Processing Fees','expense','finance'),
         ('5950','Uncategorised Expense','expense','other')
       ) AS a(code,name,type,subtype) ON CONFLICT DO NOTHING`, [org.id]);
    await client.query(
      `INSERT INTO accounts (organization_id, code, name, type, subtype)
       SELECT c.organization_id,
              '4' || LPAD((100 + ROW_NUMBER() OVER (ORDER BY c.sort_order))::text,3,'0'),
              c.name, 'income', 'operating'
         FROM income_categories c WHERE c.organization_id = $1 ON CONFLICT DO NOTHING`, [org.id]);
    await client.query(
      `INSERT INTO accounts (organization_id, code, name, type, subtype)
       SELECT c.organization_id,
              '5' || LPAD((100 + ROW_NUMBER() OVER (ORDER BY c.sort_order))::text,3,'0'),
              c.name, 'expense', 'operating'
         FROM expense_categories c WHERE c.organization_id = $1 ON CONFLICT DO NOTHING`, [org.id]);
    await client.query(
      `UPDATE income_categories c SET account_id = a.id FROM accounts a
        WHERE a.organization_id = c.organization_id AND a.name = c.name AND a.type='income'
          AND c.organization_id = $1`, [org.id]);
    await client.query(
      `UPDATE expense_categories c SET account_id = a.id FROM accounts a
        WHERE a.organization_id = c.organization_id AND a.name = c.name AND a.type='expense'
          AND c.organization_id = $1`, [org.id]);
  });
  return org;
}

const made = [];

(async () => {
  const stamp = Date.now();
  const org = await makeOrg(stamp);
  made.push(org.id);

  console.log('\nthe chart of accounts');
  const chart = await many('SELECT code, name, type FROM accounts WHERE organization_id = $1 ORDER BY code', [org.id]);
  check('every organisation gets one', chart.length > 20, String(chart.length));
  check('with the accounts the posting rules name',
    ['1100', '2100', '1300', '2000'].every((c) => chart.some((a) => a.code === c)),
    'receivable, output VAT, gateway clearing, payable');
  check('and one per category that is on screen',
    chart.some((a) => a.name === 'Product Sales' && a.type === 'income') &&
    chart.some((a) => a.name === 'Rent - Business Premises' && a.type === 'expense'),
    'so a P&L breaks down the way the categories do');

  // Migration 009 gave every organisation that existed at the time a chart of
  // accounts, and signup was not taught to do the same — so the first invoice
  // on any new account failed with "no receivable account". The seed and the
  // migration now read from one list, and this is the check that they do.
  console.log('\na brand-new organisation can post immediately');
  const fresh = await one("INSERT INTO organizations (name) VALUES ($1) RETURNING *", ['Ledger fresh ' + stamp]);
  made.push(fresh.id);
  await tx((c) => seedChartOfAccounts(c, fresh.id, 'sme'));
  const freshChart = await many('SELECT code FROM accounts WHERE organization_id = $1', [fresh.id]);
  check('signup gives it a chart of accounts', freshChart.length > 20, String(freshChart.length));
  check('including every account the posting rules name',
    ['1000', '1010', '1100', '1300', '2000', '2100', '3900', '4900', '5950']
      .every((c) => freshChart.some((a) => a.code === c)),
    'a missing one fails at the first invoice, not at signup');
  const freshPost = await tx((c) => post.cashTransaction(c, {
    orgId: fresh.id,
    tx: { id: null, type: 'income', date: today(), amount: 5000, category: 'Product Sales', description: 'First sale', method: 'Bank transfer', source: 'manual' }
  }));
  check('and it posts', Boolean(freshPost && freshPost.id));
  check('balanced', (await reports.trialBalance(fresh.id)).balanced);
  // Running the seed twice must not produce a second chart.
  await tx((c) => require('../src/accounting/accounts').ensure(c, fresh.id));
  check('seeding twice adds nothing',
    (await many('SELECT code FROM accounts WHERE organization_id = $1', [fresh.id])).length === freshChart.length);

  console.log('\nan invoice is issued');
  // ₦100,000 of services plus 7.5% VAT.
  const invoice = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date,
                           total, base_status, total_kobo, subtotal_kobo, category)
     VALUES ($1,'INV-GL-1','Zenith Foods',$2,$3,107500,'sent',10750000,10000000,'Service Fees')
     RETURNING *`,
    [org.id, daysAgo(10), daysAgo(-4)]
  );
  await tx((c) => post.invoiceIssued(c, {
    orgId: org.id, invoice,
    lines: [{ description: 'Consulting', net: 10000000, category: 'Service Fees' }],
    totals: { net: 10000000, tax: 750000, total: 10750000 }
  }));

  const afterIssue = await reports.trialBalance(org.id);
  check('the trial balance balances', afterIssue.balanced, 'difference ' + afterIssue.difference);
  const find = (tb, code) => (tb.accounts.find((a) => a.code === code) || { balance: 0 }).balance;
  check('receivables are the full amount owed',
    find(afterIssue, '1100') === 10750000, money.format(find(afterIssue, '1100')));
  check('revenue is the net, not the gross',
    afterIssue.accounts.find((a) => a.name === 'Service Fees').balance === 10000000,
    'VAT is collected for the revenue service, it is not turnover');
  check('output VAT is a liability of its own',
    find(afterIssue, '2100') === 750000, money.format(find(afterIssue, '2100')));

  console.log('\nand cannot be posted twice');
  const again = await tx((c) => post.invoiceIssued(c, {
    orgId: org.id, invoice,
    lines: [{ description: 'Consulting', net: 10000000, category: 'Service Fees' }],
    totals: { net: 10000000, tax: 750000, total: 10750000 }
  }));
  check('a second attempt is recognised, not repeated', again.alreadyPosted === true);
  const afterRetry = await reports.trialBalance(org.id);
  check('and the figures do not move',
    find(afterRetry, '1100') === 10750000 && afterRetry.balanced,
    'duplicate revenue is the characteristic failure of this kind of integration');

  console.log('\na part payment arrives');
  const payment = await one(
    'INSERT INTO invoice_payments (invoice_id, date, amount) VALUES ($1,$2,40000) RETURNING *',
    [invoice.id, daysAgo(2)]
  );
  await tx((c) => post.invoicePaid(c, {
    orgId: org.id, invoice, payment, amountKobo: 4000000
  }));
  const afterPay = await reports.trialBalance(org.id);
  check('it still balances', afterPay.balanced, 'difference ' + afterPay.difference);
  check('the bank has the money', find(afterPay, '1010') === 4000000, money.format(find(afterPay, '1010')));
  check('the receivable is reduced by exactly that',
    find(afterPay, '1100') === 6750000, money.format(find(afterPay, '1100')));
  check('and revenue has not moved',
    afterPay.accounts.find((a) => a.name === 'Service Fees').balance === 10000000,
    'revenue was earned when the invoice was issued, not when the cash arrived');

  console.log('\nwhat the reports say');
  const pl = await reports.profitAndLoss(org.id);
  check('the P&L shows the net revenue', pl.totalIncome === 10000000, money.format(pl.totalIncome));
  check('on the accrual basis', pl.basis === 'accrual');
  const bs = await reports.balanceSheet(org.id);
  check('the balance sheet balances', bs.balanced, 'difference ' + money.format(bs.difference));
  check('assets are the bank plus what is still owed',
    bs.totalAssets === 4000000 + 6750000, money.format(bs.totalAssets));
  check('liabilities are the VAT owed', bs.totalLiabilities === 750000, money.format(bs.totalLiabilities));
  check('and equity is what has been earned', bs.retainedEarnings === 10000000, money.format(bs.retainedEarnings));

  const ageing = await reports.receivablesAgeing(org.id);
  check('ageing finds the open invoice', ageing.total === 6750000, money.format(ageing.total));
  check('and it reconciles to the ledger',
    ageing.reconciles, 'ledger ' + money.format(ageing.ledgerReceivable) + ' vs ' + money.format(ageing.total));
  check('an invoice not yet due is current',
    ageing.buckets.current === 6750000, JSON.stringify(ageing.buckets));

  console.log('\na bill, and a cash expense');
  const bill = await one(
    `INSERT INTO bills (organization_id, number, vendor_name, issue_date, due_date, total, base_status, category)
     VALUES ($1,'BILL-GL-1','Lagos Depot',$2,$3,50000,'sent','Inventory Purchases') RETURNING *`,
    [org.id, daysAgo(8), daysAgo(1)]
  );
  await tx((c) => post.billIssued(c, { orgId: org.id, bill }));
  const cashTx = await one(
    `INSERT INTO transactions (organization_id, type, date, amount, category, description, method, source)
     VALUES ($1,'expense',$2,12000,'Utilities','Ikeja Electric','Bank transfer','manual') RETURNING *`,
    [org.id, daysAgo(3)]
  );
  await tx((c) => post.cashTransaction(c, { orgId: org.id, tx: cashTx }));

  const afterCosts = await reports.trialBalance(org.id);
  check('everything still balances', afterCosts.balanced, 'difference ' + afterCosts.difference);
  check('the payable is recorded', find(afterCosts, '2000') === 5000000, money.format(find(afterCosts, '2000')));
  check('the expense hits its own category account',
    afterCosts.accounts.find((a) => a.name === 'Utilities').balance === 1200000,
    money.format(afterCosts.accounts.find((a) => a.name === 'Utilities').balance));

  console.log('\nan invoice payment through the cash book does not double count');
  // This is the row the existing payment route writes. It must settle the
  // receivable, not post revenue a second time.
  const invoiceCash = await one(
    `INSERT INTO transactions (organization_id, type, date, amount, category, description, method, source, ref_invoice_id)
     VALUES ($1,'income',$2,20000,'Product Sales','Payment against INV-GL-1','Bank transfer','invoice',$3)
     RETURNING *`,
    [org.id, daysAgo(1), invoice.id]
  );
  const revenueBefore = (await reports.trialBalance(org.id)).accounts
    .filter((a) => a.type === 'income').reduce((a, x) => a + x.balance, 0);
  await tx((c) => post.cashTransaction(c, { orgId: org.id, tx: invoiceCash }));
  const afterInvCash = await reports.trialBalance(org.id);
  const revenueAfter = afterInvCash.accounts
    .filter((a) => a.type === 'income').reduce((a, x) => a + x.balance, 0);
  check('revenue is unchanged by a payment', revenueAfter === revenueBefore,
    money.format(revenueBefore) + ' -> ' + money.format(revenueAfter));
  check('the receivable falls instead',
    find(afterInvCash, '1100') === 6750000 - 2000000, money.format(find(afterInvCash, '1100')));
  check('and it balances', afterInvCash.balanced);

  console.log('\nthings that must be refused');
  let refused = null;
  try {
    await tx((c) => post.post(c, {
      orgId: org.id, date: today(), memo: 'lopsided',
      lines: [
        { accountId: chart.find((a) => a.code === '1010').id || null, debit: 100 },
        { accountId: chart.find((a) => a.code === '1100').id || null, credit: 50 }
      ]
    }));
  } catch (e) { refused = e.message; }
  check('an entry that does not balance', /does not balance/.test(String(refused)), String(refused));

  const accounts = await many('SELECT id, code FROM accounts WHERE organization_id = $1', [org.id]);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  let bothSides = null;
  try {
    await tx((c) => post.post(c, {
      orgId: org.id, date: today(), memo: 'both sides',
      lines: [{ accountId: acc('1010'), debit: 100, credit: 100 }]
    }));
  } catch (e) { bothSides = e.message; }
  check('a line that is both a debit and a credit',
    /debit or a credit/.test(String(bothSides)), String(bothSides));

  // The database's own guarantee, bypassing the module entirely — because the
  // module is not the only thing that will ever write to these tables.
  let dbRefused = null;
  try {
    await tx(async (c) => {
      const entry = (await c.query(
        `INSERT INTO journal_entries (organization_id, entry_date, memo) VALUES ($1,$2,'direct') RETURNING *`,
        [org.id, today()]
      )).rows[0];
      await c.query(
        `INSERT INTO journal_lines (entry_id, organization_id, account_id, debit_kobo) VALUES ($1,$2,$3,999)`,
        [entry.id, org.id, acc('1010')]
      );
    });
  } catch (e) { dbRefused = e.message; }
  check('and the database refuses a lopsided entry even written directly',
    /does not balance/.test(String(dbRefused)), String(dbRefused));

  console.log('\nclosed periods');
  await query('UPDATE organizations SET books_locked_through = $2 WHERE id = $1', [org.id, daysAgo(5)]);
  let locked = null;
  try {
    await tx((c) => post.post(c, {
      orgId: org.id, date: daysAgo(6), memo: 'into a closed period',
      lines: [{ accountId: acc('1010'), debit: 1000 }, { accountId: acc('1100'), credit: 1000 }]
    }));
  } catch (e) { locked = e; }
  check('nothing posts before the lock date', locked && locked.code === 'PERIOD_LOCKED', String(locked));
  const stillOpen = await tx((c) => post.post(c, {
    orgId: org.id, date: today(), memo: 'after the lock',
    lines: [{ accountId: acc('1010'), debit: 1000 }, { accountId: acc('1100'), credit: 1000 }]
  }));
  check('but today still does', Boolean(stillOpen && stillOpen.id));
  await query('UPDATE organizations SET books_locked_through = NULL WHERE id = $1', [org.id]);

  console.log('\nreversals');
  const reversed = await tx((c) => post.reverse(c, {
    orgId: org.id, entryId: stillOpen.id, date: today(), memo: 'Correcting a keying error'
  }));
  check('a reversal is posted', Boolean(reversed && reversed.id));
  const afterReversal = await reports.trialBalance(org.id);
  check('it balances', afterReversal.balanced);
  check('and the original is still there',
    Boolean(await one('SELECT id FROM journal_entries WHERE id = $1', [stillOpen.id])),
    'a correction must not erase what it corrects');
  check('with the reversal pointing at it',
    (await one('SELECT reversal_of FROM journal_entries WHERE id = $1', [reversed.id])).reversal_of === stillOpen.id);
  const twice = await tx((c) => post.reverse(c, { orgId: org.id, entryId: stillOpen.id }));
  check('reversing twice does nothing the second time', twice.alreadyPosted === true);

  console.log('\nthe backfill');
  const legacy = await makeOrg(stamp + '-legacy');
  made.push(legacy.id);
  // Books that predate the ledger: an invoice, a payment against it, and a
  // direct expense, none of them posted.
  const oldInvoice = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total, base_status, category)
     VALUES ($1,'INV-OLD-9','Bella Stores',$2,$3,80000,'sent','Product Sales') RETURNING *`,
    [legacy.id, daysAgo(40), daysAgo(26)]
  );
  await query(
    `INSERT INTO transactions (organization_id, type, date, amount, category, description, method, source, ref_invoice_id)
     VALUES ($1,'income',$2,30000,'Product Sales','Part payment','Bank transfer','invoice',$3)`,
    [legacy.id, daysAgo(20), oldInvoice.id]
  );
  await query(
    `INSERT INTO transactions (organization_id, type, date, amount, category, description, method, source)
     VALUES ($1,'expense',$2,5000,'Bank Charges','COT','Bank transfer','manual')`,
    [legacy.id, daysAgo(15)]
  );

  const before = await reports.coverage(legacy.id);
  check('starts with nothing posted', before.entries === 0 && !before.complete, JSON.stringify(before));

  // Scoped to this organisation: an unscoped run would post every other
  // business's history as a side effect of testing this one.
  await backfill.run({ organizationId: legacy.id });
  const after = await reports.coverage(legacy.id);
  check('posts everything', after.complete, JSON.stringify(after));
  const legacyTb = await reports.trialBalance(legacy.id);
  check('and the result balances', legacyTb.balanced, 'difference ' + legacyTb.difference);
  check('the invoice became a receivable',
    find(legacyTb, '1100') === 8000000 - 3000000, money.format(find(legacyTb, '1100')));
  check('revenue is the invoice, counted once',
    legacyTb.accounts.find((a) => a.name === 'Product Sales').balance === 8000000,
    'not the invoice plus the payment against it');

  const rerun = await backfill.run({ organizationId: legacy.id });
  const afterRerun = await reports.trialBalance(legacy.id);
  check('running it again posts nothing',
    rerun.invoices === 0 && rerun.transactions === 0, JSON.stringify(rerun));
  check('and changes no figure',
    find(afterRerun, '1100') === find(legacyTb, '1100') &&
    afterRerun.debits === legacyTb.debits,
    'this is what makes it safe to run at boot, by hand, or after a crash');

  // Found on real data, not in a test: the demo seeder and any direct import
  // write an invoice_payments row with no cash-book row behind it. The
  // backfill only read the cash book, so those payments were invisible and
  // every one of them left a receivable open against money that had arrived.
  // The trial balance still balanced — which is why this needs its own check:
  // a ledger can be internally consistent and still disagree with the books.
  console.log('\na payment recorded straight onto a document');
  const seeded = await makeOrg(stamp + '-seeded');
  made.push(seeded.id);
  const seededInvoice = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total, base_status, category)
     VALUES ($1,'INV-SEED-1','Direct Payer',$2,$3,100000,'sent','Product Sales') RETURNING *`,
    [seeded.id, daysAgo(30), daysAgo(16)]
  );
  // No transactions row, exactly as the seeder leaves it.
  await query('INSERT INTO invoice_payments (invoice_id, date, amount) VALUES ($1,$2,100000)',
    [seededInvoice.id, daysAgo(12)]);
  const seededBill = await one(
    `INSERT INTO bills (organization_id, number, vendor_name, issue_date, due_date, total, base_status, category)
     VALUES ($1,'BILL-SEED-1','Supplier Ltd',$2,$3,25000,'sent','Inventory Purchases') RETURNING *`,
    [seeded.id, daysAgo(30), daysAgo(16)]
  );
  await query('INSERT INTO bill_payments (bill_id, date, amount) VALUES ($1,$2,25000)',
    [seededBill.id, daysAgo(10)]);

  await backfill.run({ organizationId: seeded.id });
  const seededTb = await reports.trialBalance(seeded.id);
  check('it balances', seededTb.balanced, 'difference ' + seededTb.difference);
  check('the receivable is settled, not left open',
    find(seededTb, '1100') === 0, money.format(find(seededTb, '1100')));
  check('and so is the payable', find(seededTb, '2000') === 0, money.format(find(seededTb, '2000')));
  const seededAgeing = await reports.receivablesAgeing(seeded.id);
  check('ageing reconciles to the ledger', seededAgeing.reconciles,
    money.format(seededAgeing.ledgerReceivable) + ' vs ' + money.format(seededAgeing.total));
  check('with nothing outstanding', seededAgeing.total === 0, money.format(seededAgeing.total));

  // A payment that does have a cash-book row must settle once, not twice.
  const bothWays = await makeOrg(stamp + '-bothways');
  made.push(bothWays.id);
  const bwInvoice = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total, base_status, category)
     VALUES ($1,'INV-BW-1','Both Ways Ltd',$2,$3,60000,'sent','Product Sales') RETURNING *`,
    [bothWays.id, daysAgo(20), daysAgo(6)]
  );
  const bwPayment = await one(
    'INSERT INTO invoice_payments (invoice_id, date, amount) VALUES ($1,$2,60000) RETURNING *',
    [bwInvoice.id, daysAgo(5)]
  );
  await query(
    `INSERT INTO transactions (organization_id, type, date, amount, category, description, method, source, ref_invoice_id, ref_payment_id)
     VALUES ($1,'income',$2,60000,'Product Sales','Payment against INV-BW-1','Bank transfer','invoice',$3,$4)`,
    [bothWays.id, daysAgo(5), bwInvoice.id, bwPayment.id]
  );
  await backfill.run({ organizationId: bothWays.id });
  const bwTb = await reports.trialBalance(bothWays.id);
  check('a payment with a cash-book row settles exactly once',
    find(bwTb, '1100') === 0, money.format(find(bwTb, '1100')) + ' — minus 60,000 would mean it settled twice');
  check('and the bank holds it once', find(bwTb, '1010') === 6000000, money.format(find(bwTb, '1010')));
  check('and it balances', bwTb.balanced);

  console.log('\none name, one account');
  const names = await many(
    `SELECT type, lower(name) n, count(*)::int c FROM accounts WHERE organization_id = $1
      GROUP BY 1,2 HAVING count(*) > 1`, [org.id]
  );
  check('no two accounts share a name and type', names.length === 0, JSON.stringify(names));

  console.log('\ntenant isolation');
  const theirs = await reports.trialBalance(legacy.id);
  const ours = await reports.trialBalance(org.id);
  check('one organisation\'s ledger holds none of another\'s',
    theirs.debits !== ours.debits && theirs.debits > 0 && ours.debits > 0,
    'both have figures and they are not the same');
  check('and an account id from one cannot be read under the other',
    (await reports.ledgerFor(legacy.id, acc('1010'))).length === 0,
    'the organisation is part of the query, not checked afterwards');

  console.log('\nwhat the existing cash book still says');
  // The point of the whole exercise: nothing already in the product changed.
  const cashIncome = await one(
    "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE organization_id = $1 AND type='income'",
    [legacy.id]
  );
  check('the cash ledger is untouched', Number(cashIncome.total) === 30000,
    'the existing reports read this and must keep reading the same figure');

  for (const id of made) await query('DELETE FROM organizations WHERE id = $1', [id]);

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  for (const id of made) await query('DELETE FROM organizations WHERE id = $1', [id]).catch(() => {});
  process.exit(1);
});
