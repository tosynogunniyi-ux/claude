// Do invoices that raise themselves raise the right ones, once?
//   npm run test:recurring
//
// The question a recurring-billing test has to answer is not "did it make an
// invoice" but "did it make exactly one, on the right day, for the right
// amount, and can anything make it make two". Duplicate billing is the
// characteristic failure of this feature and the expensive one: a customer
// billed twice for March assumes the rest of their account is equally
// reliable.
//
// Everything runs against the real database, because the guarantee that stops
// the double is a unique index and a transaction, and a test with a stubbed
// database would be testing the stub.

require('dotenv').config();
const { pool, one, many, query, tx } = require('../src/db');
const money = require('../src/money');
const recurring = require('../src/invoicing/recurring');
const reports = require('../src/accounting/reports');
const owed = require('../src/invoicing/outstanding');
const accounts = require('../src/accounting/accounts');
const { seedChartOfAccounts } = require('../src/defaults');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const made = [];

async function makeOrg(tag, vatRegistered) {
  const org = await one(
    'INSERT INTO organizations (name, vat_registered, vat_rate) VALUES ($1, $2, 7.5) RETURNING *',
    ['Recurring ' + tag, vatRegistered !== false]
  );
  made.push(org.id);
  await tx(async (client) => {
    await seedChartOfAccounts(client, org.id, 'sme');
    await accounts.ensure(client, org.id);
  });
  return org;
}

async function makeSchedule(orgId, over) {
  const b = Object.assign({
    name: 'Retainer', party: 'Ada Nwosu', frequency: 'monthly', intervalCount: 1,
    start: today(), dueDays: 14, lines: [{ description: 'Monthly retainer', qty: 1, unitPrice: '250000' }]
  }, over || {});

  return tx(async (client) => {
    const contact = (await client.query(
      `INSERT INTO clients (organization_id, name) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING *`, [orgId, b.party]
    )).rows[0] || (await client.query(
      'SELECT * FROM clients WHERE organization_id = $1 AND name = $2', [orgId, b.party]
    )).rows[0];

    const row = (await client.query(
      `INSERT INTO recurring_invoices
         (organization_id, name, client_id, client_name, frequency, interval_count,
          start_date, end_date, max_occurrences, next_due, due_days, template)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,'executive') RETURNING *`,
      [orgId, b.name, contact.id, b.party, b.frequency, b.intervalCount,
        b.start, b.end || null, b.maxOccurrences || null, b.dueDays]
    )).rows[0];

    for (let i = 0; i < b.lines.length; i++) {
      const l = b.lines[i];
      await client.query(
        `INSERT INTO recurring_invoice_lines
           (recurring_invoice_id, organization_id, position, description, qty_milli,
            unit_price_kobo, tax_treatment)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, orgId, i, l.description, money.toQty(l.qty), money.toKobo(l.unitPrice),
          l.taxTreatment || 'standard']
      );
    }
    return row;
  });
}

const scheduleNow = (id) => one('SELECT * FROM recurring_invoices WHERE id = $1', [id]);
const invoicesOf = (id) => many(
  'SELECT * FROM invoices WHERE recurring_invoice_id = $1 ORDER BY recurring_occurrence', [id]);

(async () => {
  try {
    // =====================================================================
    console.log('\nthe dates, which is where this quietly goes wrong');

    // A monthly schedule anchored on the 31st. Adding 30 days, or clamping
    // and carrying the clamp forward, both walk the date backwards a little
    // every year — and nobody notices until a customer asks why January's
    // invoice arrived on the 26th.
    let d = '2026-01-31';
    const run = [];
    for (let i = 0; i < 7; i++) { run.push(d); d = recurring.advance(d, 'monthly', 1, 31); }
    check('the 31st survives February and comes back',
      run.join(' ') === '2026-01-31 2026-02-28 2026-03-31 2026-04-30 2026-05-31 2026-06-30 2026-07-31',
      run.join(' '));

    check('a fortnight is two weeks, not half a month',
      recurring.advance('2026-03-04', 'weekly', 2) === '2026-03-18',
      recurring.advance('2026-03-04', 'weekly', 2));
    check('a quarter is three months',
      recurring.advance('2026-01-15', 'quarterly', 1, 15) === '2026-04-15');
    check('a year over a leap day lands on the 28th',
      recurring.advance('2028-02-29', 'yearly', 1, 29) === '2029-02-28',
      recurring.advance('2028-02-29', 'yearly', 1, 29));
    check('and the due date is the issue date plus the terms',
      recurring.addDays('2026-01-31', 30) === '2026-03-02');

    // =====================================================================
    console.log('\none schedule, raising one invoice');

    const org = await makeOrg('A');
    const monthly = await makeSchedule(org.id, { start: today(), lines: [
      { description: 'Monthly retainer', qty: 1, unitPrice: '250000' }
    ] });

    const first = await recurring.runSchedule(monthly.id, { asOf: today() });
    check('it raises the one that is due', first.raised.length === 1,
      String(first.raised.length));

    const raised = await invoicesOf(monthly.id);
    check('the invoice takes a number from the ordinary series',
      /^INV-\d{4}-\d{5}$/.test(raised[0].number), raised[0].number);
    check('it is issued, not left as a draft',
      raised[0].base_status === 'sent' && raised[0].issued_at !== null, raised[0].base_status);
    check('the VAT is applied because the business is registered',
      Number(raised[0].total_kobo) === 26875000 && Number(raised[0].tax_kobo) === 1875000,
      raised[0].total_kobo + ' total, ' + raised[0].tax_kobo + ' tax');
    check('the due date is the terms after the issue date',
      raised[0].due_date === recurring.addDays(raised[0].issue_date, 14),
      raised[0].issue_date + ' -> ' + raised[0].due_date);
    check('it knows which schedule raised it, and which occurrence it was',
      raised[0].recurring_invoice_id === monthly.id && raised[0].recurring_occurrence === 1);

    const after = await scheduleNow(monthly.id);
    check('the schedule moved on exactly one period',
      after.next_due === recurring.advance(today(), 'monthly', 1, Number(today().slice(8))) &&
      after.issued_count === 1,
      after.next_due + ', issued ' + after.issued_count);

    const events = await many(
      "SELECT event, detail FROM invoice_events WHERE invoice_id = $1 ORDER BY occurred_at", [raised[0].id]);
    check('the invoice says it came from a schedule, not from a person',
      events.some((e) => e.detail && e.detail.source === 'recurring') &&
      raised[0].created_at !== null,
      JSON.stringify(events.map((e) => e.event)));

    console.log('\nand into the ledger, like any other invoice');
    const tb = await reports.trialBalance(org.id);
    check('the trial balance balances', tb.balanced, 'off by ' + tb.difference);
    check('the receivable is the invoice total',
      (await balanceOf(org.id, '1100')) === 26875000, String(await balanceOf(org.id, '1100')));
    check('and the VAT is a liability, not revenue',
      (await balanceOf(org.id, '2100')) === -1875000, String(await balanceOf(org.id, '2100')));
    const ageing = await reports.receivablesAgeing(org.id);
    check('receivables reconcile with the ledger', ageing.reconciles, 'off by ' + ageing.difference);

    // =====================================================================
    console.log('\nnever twice');

    const again = await recurring.runSchedule(monthly.id, { asOf: today() });
    check('running it again today raises nothing', again.raised.length === 0,
      String(again.raised.length));
    check('and there is still one invoice', (await invoicesOf(monthly.id)).length === 1);

    // Six passes at once, the shape of two containers and a person pressing
    // the button while the hourly timer fires.
    const racy = await makeSchedule(org.id, { name: 'Racy', start: today(),
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '100000' }] });
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => recurring.runSchedule(racy.id, { asOf: today() }))
    );
    const total = results.reduce((a, r) => a + r.raised.length, 0);
    check('six simultaneous passes raise one invoice between them',
      total === 1 && (await invoicesOf(racy.id)).length === 1,
      total + ' raised, ' + (await invoicesOf(racy.id)).length + ' invoices');

    // And the backstop, with the generator taken out of the picture entirely.
    let duplicate = null;
    try {
      const existing = (await invoicesOf(racy.id))[0];
      await query(
        `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total,
                subtotal_kobo, total_kobo, base_status, recurring_invoice_id, recurring_occurrence)
         VALUES ($1,'DUP-1','Ada Nwosu',$2,$2,1000,100000,100000,'sent',$3,$4)`,
        [org.id, today(), racy.id, existing.recurring_occurrence]
      );
    } catch (err) { duplicate = err; }
    check('and the database refuses a second invoice for the same occurrence',
      duplicate && duplicate.code === '23505',
      duplicate ? duplicate.code : 'it was accepted');

    // =====================================================================
    console.log('\ncatching up on a schedule that started in the past');

    const backdated = await makeOrg('B');
    const retro = await makeSchedule(backdated.id, {
      start: '2026-06-15', dueDays: 30,
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '100000', taxTreatment: 'no_vat' }]
    });
    const caught = await recurring.runSchedule(retro.id, { asOf: '2026-10-15' });
    check('every period since the start date is raised',
      caught.raised.length === 5, String(caught.raised.length) + ' (June to October)');
    const retroInvoices = await invoicesOf(retro.id);
    check('each one carries the date of the period it is for',
      retroInvoices.map((i) => i.issue_date).join(' ') ===
        '2026-06-15 2026-07-15 2026-08-15 2026-09-15 2026-10-15',
      retroInvoices.map((i) => i.issue_date).join(' '));
    check('and they are numbered in the order they were issued',
      retroInvoices.every((i, n) => i.recurring_occurrence === n + 1));
    check('the schedule is now pointing at November',
      (await scheduleNow(retro.id)).next_due === '2026-11-15',
      (await scheduleNow(retro.id)).next_due);
    const tbB = await reports.trialBalance(backdated.id);
    check('five invoices, still balanced', tbB.balanced, 'off by ' + tbB.difference);
    check('and the receivable is all five',
      (await balanceOf(backdated.id, '1100')) === 50000000,
      String(await balanceOf(backdated.id, '1100')));

    // A start date mistyped by a decade must not produce a hundred invoices.
    const runaway = await makeSchedule(backdated.id, {
      name: 'Runaway', start: '2015-01-01',
      lines: [{ description: 'Oops', qty: 1, unitPrice: '1000', taxTreatment: 'no_vat' }]
    });
    const capped = await recurring.runSchedule(runaway.id, { asOf: today(), limit: 12 });
    check('a catch-up is capped rather than running away',
      capped.raised.length === 12 && capped.capped === true,
      capped.raised.length + ' raised, capped ' + capped.capped);

    // =====================================================================
    console.log('\nstopping, in the three ways it stops');

    const ending = await makeSchedule(backdated.id, {
      name: 'Three months only', start: '2026-07-01', maxOccurrences: 3,
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '50000', taxTreatment: 'no_vat' }]
    });
    const limited = await recurring.runSchedule(ending.id, { asOf: '2026-12-01' });
    check('a schedule with a limit raises exactly that many',
      limited.raised.length === 3, String(limited.raised.length));
    check('and then says it is finished, and why',
      limited.stopped === 'completed' &&
      (await scheduleNow(ending.id)).status === 'finished',
      limited.stopped);

    const expiring = await makeSchedule(backdated.id, {
      name: 'Until September', start: '2026-07-10', end: '2026-09-30',
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '50000', taxTreatment: 'no_vat' }]
    });
    const expired = await recurring.runSchedule(expiring.id, { asOf: '2026-12-01' });
    check('a schedule with an end date stops at it',
      expired.raised.length === 3 && expired.stopped === 'ended',
      expired.raised.length + ' raised, ' + expired.stopped);
    check('nothing is raised after the end date',
      (await invoicesOf(expiring.id)).every((i) => i.issue_date <= '2026-09-30'));

    const broken = await makeSchedule(backdated.id, { name: 'No lines', start: today() });
    await query('DELETE FROM recurring_invoice_lines WHERE recurring_invoice_id = $1', [broken.id]);
    const failedRun = await recurring.runSchedule(broken.id, { asOf: today() });
    const brokenNow = await scheduleNow(broken.id);
    check('a schedule that cannot raise its invoice stops and says why',
      brokenNow.status === 'paused' && /no lines/i.test(brokenNow.last_error || ''),
      brokenNow.status + ': ' + brokenNow.last_error);
    check('rather than failing once an hour into a log nobody reads',
      failedRun.raised.length === 0 && Boolean(failedRun.failed));

    console.log('\nand a closed period stops it too');
    const closed = await makeSchedule(backdated.id, {
      name: 'Closed books', start: daysAgo(3),
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '10000', taxTreatment: 'no_vat' }]
    });
    await query('UPDATE organizations SET books_locked_through = $2 WHERE id = $1',
      [backdated.id, today()]);
    await recurring.runSchedule(closed.id, { asOf: today() });
    const lockedNow = await scheduleNow(closed.id);
    check('nothing is raised into books that are closed',
      lockedNow.status === 'paused' && /closed/i.test(lockedNow.last_error || ''),
      lockedNow.status + ': ' + lockedNow.last_error);
    check('and no invoice was left behind without its ledger entry',
      (await invoicesOf(closed.id)).length === 0);
    await query('UPDATE organizations SET books_locked_through = NULL WHERE id = $1', [backdated.id]);

    // =====================================================================
    console.log('\npausing, skipping, resuming');

    const pausing = await makeOrg('C');
    const sched = await makeSchedule(pausing.id, {
      start: '2026-06-01', lines: [{ description: 'Retainer', qty: 1, unitPrice: '80000', taxTreatment: 'no_vat' }]
    });
    await recurring.runSchedule(sched.id, { asOf: '2026-07-01' });
    check('two months raised before the pause',
      (await invoicesOf(sched.id)).length === 2, String((await invoicesOf(sched.id)).length));

    await query("UPDATE recurring_invoices SET status = 'paused', paused_at = now() WHERE id = $1", [sched.id]);
    await recurring.runSchedule(sched.id, { asOf: '2026-10-01' });
    check('a paused schedule raises nothing',
      (await invoicesOf(sched.id)).length === 2);

    // Resuming the way the route does it: skip the periods it was paused for.
    // Catching up would raise invoices for three months nobody was billed
    // for, which is almost never what a pause meant.
    const resumed = await tx(async (client) => {
      const s = (await client.query('SELECT * FROM recurring_invoices WHERE id = $1', [sched.id])).rows[0];
      let next = s.next_due;
      let skipped = 0;
      while (next < '2026-10-01') {
        next = recurring.advance(next, s.frequency, s.interval_count, recurring.anchorOf(s));
        skipped += 1;
      }
      return (await client.query(
        `UPDATE recurring_invoices SET status='active', paused_at=NULL, next_due=$2,
                skipped_count=$3 WHERE id=$1 RETURNING *`,
        [sched.id, next, skipped]
      )).rows[0];
    });
    // August and September: the two periods that fell inside the pause. The
    // October one is not a skip, it is the next one due.
    check('resuming skips the periods it was paused for rather than billing them',
      resumed.next_due === '2026-10-01' && resumed.skipped_count === 2,
      resumed.next_due + ', skipped ' + resumed.skipped_count);
    await recurring.runSchedule(sched.id, { asOf: '2026-10-01' });
    check('and then carries on from there',
      (await invoicesOf(sched.id)).length === 3 &&
      (await invoicesOf(sched.id))[2].issue_date === '2026-10-01',
      (await invoicesOf(sched.id)).map((i) => i.issue_date).join(' '));

    // =====================================================================
    console.log('\nthe figures are worked out again each time, not frozen');

    const vatLater = await makeOrg('D', false);
    const sched2 = await makeSchedule(vatLater.id, {
      start: '2026-08-01', lines: [{ description: 'Service', qty: 1, unitPrice: '100000' }]
    });
    await recurring.runSchedule(sched2.id, { asOf: '2026-08-01' });
    const beforeVat = (await invoicesOf(sched2.id))[0];
    check('a business that is not VAT-registered is not charged VAT',
      Number(beforeVat.total_kobo) === 10000000 && Number(beforeVat.tax_kobo) === 0,
      beforeVat.total_kobo + ' / ' + beforeVat.tax_kobo);

    await query('UPDATE organizations SET vat_registered = true WHERE id = $1', [vatLater.id]);
    await recurring.runSchedule(sched2.id, { asOf: '2026-09-01' });
    const afterVat = (await invoicesOf(sched2.id))[1];
    check('registering for VAT reaches next month’s invoice',
      Number(afterVat.total_kobo) === 10750000 && Number(afterVat.tax_kobo) === 750000,
      afterVat.total_kobo + ' / ' + afterVat.tax_kobo);
    check('and the one already raised is not rewritten',
      Number((await invoicesOf(sched2.id))[0].total_kobo) === 10000000);

    // =====================================================================
    console.log('\nawkward money, through the whole path');

    const awkward = await makeOrg('E', false);
    const pennies = await makeSchedule(awkward.id, {
      start: today(),
      lines: [{ description: 'Odd amount', qty: 1, unitPrice: '10000.05', taxTreatment: 'no_vat' }]
    });
    await recurring.runSchedule(pennies.id, { asOf: today() });
    const odd = (await invoicesOf(pennies.id))[0];
    check('₦10,000.05 is 1000005 kobo, not 1000004.9999',
      Number(odd.total_kobo) === 1000005, String(odd.total_kobo));
    const tbE = await reports.trialBalance(awkward.id);
    check('and the books balance on it', tbE.balanced, 'off by ' + tbE.difference);

    // =====================================================================
    console.log('\none organisation cannot bill another’s customer');

    const mine = await makeOrg('F');
    const theirs = await makeOrg('G');
    const mineSched = await makeSchedule(mine.id, { start: today(),
      lines: [{ description: 'Retainer', qty: 1, unitPrice: '10000', taxTreatment: 'no_vat' }] });
    await recurring.runSchedule(mineSched.id, { asOf: today() });
    const theirsDue = await recurring.due({ asOf: today(), organizationId: theirs.id });
    check('a pass narrowed to one organisation sees only its own schedules',
      theirsDue.length === 0 &&
      (await recurring.due({ asOf: today(), organizationId: mine.id })).length >= 0);
    const leaked = await one(
      'SELECT COUNT(*)::int n FROM invoices WHERE organization_id = $1 AND recurring_invoice_id = $2',
      [theirs.id, mineSched.id]);
    check('and no invoice landed in the other organisation’s books', leaked.n === 0);

    // =====================================================================
    console.log('\nwhat the screen is told');

    const previewed = recurring.preview(await scheduleNow(retro.id), 4);
    check('a schedule can say what it will raise before it raises it',
      previewed.length === 4 && previewed[0].issue === '2026-11-15' &&
      previewed[0].due === '2026-12-15',
      JSON.stringify(previewed.map((p) => p.issue)));
    check('and the preview stops at the end of a limited schedule',
      recurring.preview(await scheduleNow(ending.id), 6).length === 0,
      'a finished schedule has nothing upcoming');

    const dash = await one(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'paused')::int AS paused
         FROM recurring_invoices WHERE organization_id = $1`, [backdated.id]);
    check('the dashboard can count what is running and what is stopped',
      dash.active >= 1 && dash.paused >= 2, JSON.stringify(dash));

    console.log('');
    if (failures.length) {
      console.log(passed + ' passed, ' + failures.length + ' failed');
      for (const f of failures) console.log('  - ' + f);
      await cleanup();
      process.exit(1);
    }
    console.log(passed + ' passed, 0 failed');
    await cleanup();
    await pool.end();
  } catch (err) {
    console.error('\n' + (err && err.stack ? err.stack : err));
    await cleanup();
    process.exit(1);
  }
})();

async function balanceOf(orgId, code) {
  const row = await one(
    `SELECT COALESCE(SUM(l.debit_kobo - l.credit_kobo), 0) AS n
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.organization_id = $1 AND a.code = $2`,
    [orgId, code]
  );
  return Number(row.n);
}

async function cleanup() {
  for (const id of made) await query('DELETE FROM organizations WHERE id = $1', [id]).catch(() => {});
}
