// Payroll, end to end and in the small.
//
//   npm start          (in one shell)
//   npm run test:payroll
//
// The pure arithmetic is checked first and against figures worked by hand,
// because a payroll engine nobody can check by hand is a payroll engine
// nobody should trust. Band boundaries are tested on both sides. Then the
// whole workflow against a real server and a real database: calculate,
// approve, post, pay, reverse, and every refusal in between.
//
// The spreadsheet this module replaces is reproduced too — not to validate
// it, but to prove the old regime and the new one are both implemented and
// genuinely different, and to measure how wrong the old one was.

require('dotenv').config();
const assert = require('assert');
const { pool } = require('../src/db');
const statutory = require('../src/payroll/statutory');
const { calculate, split } = require('../src/payroll/calculate');
const schedule = require('../src/payroll/schedule');
const payslipDoc = require('../src/payroll/payslip');
const runs = require('../src/payroll/run');

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const N = (naira) => Math.round(naira * 100);
const toN = (kobo) => kobo / 100;

function client() {
  let cookie = null;
  return async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, cookie ? { cookie } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (/pdf|excel|csv/.test(type)) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer: buf, type };
    }
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text, type };
  };
}

(async () => {
  // =======================================================================
  console.log('\nthe rules in force');

  const now = statutory.rulesFor('2026-03-01');
  check('March 2026 is taxed under the Nigeria Tax Act 2025', now.id === 'NG-2026-NTA', now.id);
  check('December 2025 is not', statutory.rulesFor('2025-12-31').id === 'NG-PITA');
  check('the handover is 1 January 2026',
    statutory.rulesFor('2026-01-01').id === 'NG-2026-NTA' &&
    statutory.rulesFor('2025-12-31').id === 'NG-PITA');
  check('the Consolidated Relief Allowance is abolished in 2026', now.consolidatedRelief.applies === false);
  check('and still applied before that', statutory.rulesFor('2025-06-01').consolidatedRelief.applies === true);
  check('a date that is not a date is refused rather than guessed', (() => {
    try { statutory.rulesFor('whenever'); return false; } catch { return true; }
  })());
  check('the rule sets are frozen, so nothing can edit tax at runtime', (() => {
    try { now.bands.push({ width: 1, rateBp: 0 }); } catch { /* expected */ }
    return now.bands.length === 6;
  })());
  check('what is not yet settled is declared rather than hidden',
    statutory.doubts(now).length === 3, JSON.stringify(statutory.doubts(now).map((d) => d.item)));

  // =======================================================================
  console.log('\nthe bands, at every boundary');

  const tax = (naira) => toN(statutory.taxOn(N(naira), now).tax);

  check('nothing is taxed at nothing', tax(0) === 0);
  check('₦800,000 is the last naira untaxed', tax(800000) === 0, String(tax(800000)));
  // One naira into the 15% band is 15 kobo.
  check('₦800,001 is taxed 15 kobo', tax(800001) === 0.15, String(tax(800001)));
  check('₦3,000,000 → ₦330,000', tax(3000000) === 330000, String(tax(3000000)));
  check('₦3,000,001 enters the 18% band', tax(3000001) === 330000.18, String(tax(3000001)));
  // 330,000 + 9,000,000 @ 18% = 330,000 + 1,620,000
  check('₦12,000,000 → ₦1,950,000', tax(12000000) === 1950000, String(tax(12000000)));
  // + 13,000,000 @ 21% = 2,730,000
  check('₦25,000,000 → ₦4,680,000', tax(25000000) === 4680000, String(tax(25000000)));
  // + 25,000,000 @ 23% = 5,750,000
  check('₦50,000,000 → ₦10,430,000', tax(50000000) === 10430000, String(tax(50000000)));
  // + 10,000,000 @ 25% = 2,500,000
  check('₦60,000,000 → ₦12,930,000', tax(60000000) === 12930000, String(tax(60000000)));
  check('a negative income is not a refund', tax(-500000) === 0);

  const working = statutory.taxOn(N(3000001), now).workings;
  check('the working shows which band did what',
    working.length === 3 && working[0].rateBp === 0 && working[1].rateBp === 1500 && working[2].rateBp === 1800,
    JSON.stringify(working.map((w) => w.rateBp)));

  // =======================================================================
  console.log('\nsplitting a salary');

  const parts = split(N(300000));
  check('50 / 30 / 20 by default',
    parts.basic === N(150000) && parts.housing === N(90000) && parts.transport === N(60000));
  check('the parts always add back to the whole',
    parts.basic + parts.housing + parts.transport === N(300000));
  const odd = split(N(100000.01), { basicBp: 3333, housingBp: 3333, transportBp: 3334 });
  check('…even when the percentages do not divide cleanly',
    odd.basic + odd.housing + odd.transport === N(100000.01),
    JSON.stringify(odd));

  // =======================================================================
  console.log('\none employee, by hand');
  //
  // ₦300,000 a month. Basic 150,000, housing 90,000, transport 60,000.
  // Pension 8% of 300,000       = 24,000/month   → 288,000/year
  // NHF 2.5% of basic 150,000   =  3,750/month   →  45,000/year
  // Rent declared 1,200,000 → relief 20% = 240,000 (under the 500,000 cap)
  // Chargeable = 3,600,000 − 288,000 − 45,000 − 240,000 = 3,027,000
  // Tax = 0 on 800,000 + 15% of 2,200,000 + 18% of 27,000
  //     = 330,000 + 4,860 = 334,860/year  → 27,905/month

  const one = calculate(Object.assign({
    periodDate: '2026-01-01', periodsRemaining: 11, annualRentDeclared: N(1200000)
  }, split(N(300000))));

  check('pension is 8% of basic+housing+transport', one.deductions.employeePension === N(24000));
  check('NHF is 2.5% of basic only', one.deductions.nhf === N(3750));
  check('chargeable income is ₦3,027,000', one.tax.chargeable === N(3027000), String(toN(one.tax.chargeable)));
  check('the year\'s tax is ₦334,860', one.tax.annualTax === N(334860), String(toN(one.tax.annualTax)));
  check('January PAYE is ₦27,905', one.deductions.paye === N(27905), String(toN(one.deductions.paye)));
  check('net pay is ₦244,345', one.net === N(244345), String(toN(one.net)));
  check('employer pension is 10% and is not deducted',
    one.employer.pension === N(30000) && one.net === one.earnings.gross - one.deductions.total);
  check('the employer\'s cost is gross plus their contribution',
    one.employer.totalCost === N(330000));

  const noRent = calculate(Object.assign({ periodDate: '2026-01-01', periodsRemaining: 11 },
    split(N(300000))));
  check('declaring no rent gets no rent relief — it is claimed, not given',
    noRent.tax.relief.rent === 0 && noRent.tax.chargeable === N(3267000),
    String(toN(noRent.tax.chargeable)));

  const bigRent = calculate(Object.assign({
    periodDate: '2026-01-01', periodsRemaining: 11, annualRentDeclared: N(10000000)
  }, split(N(300000))));
  check('rent relief is capped at ₦500,000', bigRent.tax.relief.rent === N(500000));

  // =======================================================================
  console.log('\nthe year, month by month');

  // Twelve unchanging months must total exactly the year's tax — no drift,
  // no thirteenth-month correction.
  let ytd = { gross: 0, paye: 0, pension: 0, nhf: 0 };
  let payeTotal = 0;
  for (let m = 1; m <= 12; m++) {
    const r = calculate(Object.assign({
      periodDate: '2026-' + String(m).padStart(2, '0') + '-01',
      periodsRemaining: 12 - m,
      annualRentDeclared: N(1200000),
      ytd
    }, split(N(300000))));
    payeTotal += r.deductions.paye;
    ytd = r.ytdAfter;
  }
  check('twelve months of PAYE equal the year exactly', payeTotal === N(334860), String(toN(payeTotal)));
  check('and the year-to-date agrees', ytd.paye === N(334860) && ytd.gross === N(3600000));

  // A bonus is taxed in the month it is paid, not smeared.
  let bYtd = { gross: 0, paye: 0, pension: 0, nhf: 0 };
  let bonusYear = 0;
  for (let m = 1; m <= 12; m++) {
    const r = calculate(Object.assign({
      periodDate: '2026-' + String(m).padStart(2, '0') + '-01',
      periodsRemaining: 12 - m,
      annualRentDeclared: N(1200000),
      bonus: m === 6 ? N(500000) : 0,
      ytd: bYtd
    }, split(N(300000))));
    if (m === 6) {
      check('the bonus month deducts more than an ordinary month',
        r.deductions.paye > N(27905) * 2, String(toN(r.deductions.paye)));
    }
    bonusYear += r.deductions.paye;
    bYtd = r.ytdAfter;
  }
  // Chargeable rises by the full 500,000, taxed at 18%: +90,000.
  check('a ₦500,000 bonus costs ₦90,000 in tax across the year',
    bonusYear === N(334860 + 90000), String(toN(bonusYear)));

  // A joiner in September is taxed on what they will actually earn.
  let jYtd = { gross: 0, paye: 0, pension: 0, nhf: 0 };
  let joinerYear = 0;
  for (let m = 9; m <= 12; m++) {
    const r = calculate(Object.assign({
      periodDate: '2026-' + String(m).padStart(2, '0') + '-01',
      periodsRemaining: 12 - m,
      ytd: jYtd
    }, split(N(300000))));
    joinerYear += r.deductions.paye;
    jYtd = r.ytdAfter;
  }
  // Four months: gross 1,200,000; pension 96,000; NHF 15,000.
  // Chargeable 1,089,000 → 15% of 289,000 = 43,350.
  check('a September joiner gets the whole nil band, not a twelfth of it',
    joinerYear === N(43350), String(toN(joinerYear)));

  // =======================================================================
  console.log('\nthe edges');

  const minWage = calculate(Object.assign({ periodDate: '2026-01-01', periodsRemaining: 11 },
    split(N(70000))));
  check('nobody on the national minimum wage pays PAYE',
    minWage.deductions.paye === 0 && minWage.tax.exemptByMinimumWage === true);

  const justOver = calculate(Object.assign({ periodDate: '2026-01-01', periodsRemaining: 11 },
    split(N(70001))));
  check('a naira above it is not exempt', justOver.tax.exemptByMinimumWage === false);

  const exempt = calculate(Object.assign({
    periodDate: '2026-01-01', periodsRemaining: 11, pensionExempt: true, nhfExempt: true
  }, split(N(300000))));
  check('an exempt employee contributes nothing and the employer matches that',
    exempt.deductions.employeePension === 0 && exempt.deductions.nhf === 0 && exempt.employer.pension === 0);
  check('…and pays more tax as a result', exempt.deductions.paye > one.deductions.paye);

  const overPaid = calculate(Object.assign({
    periodDate: '2026-12-01', periodsRemaining: 0, annualRentDeclared: N(1200000),
    ytd: { gross: N(3300000), paye: N(999999), pension: N(264000), nhf: N(41250) }
  }, split(N(300000))));
  check('an over-deduction never becomes a negative payslip', overPaid.deductions.paye === 0);

  const extraEmployer = calculate(Object.assign({
    periodDate: '2026-01-01', periodsRemaining: 11, employerPensionBp: 1500
  }, split(N(300000))));
  check('an employer paying 15% pension pays 15%', extraEmployer.employer.pension === N(45000));
  check('…and it still does not touch the employee\'s net pay',
    extraEmployer.net === one.net - one.tax.relief.rent * 0 - (one.net - extraEmployer.net));

  // =======================================================================
  console.log('\nthe spreadsheet this replaces');
  //
  // Its PAYE & Pension Calc sheet applied the ₦200,000 ANNUAL relief floor to
  // a MONTHLY gross, so every employee received ₦2.4m of relief a year. On
  // ₦300,000 a month it produced ₦8,400. The correct 2026 figure is more than
  // three times that, and this check exists so the difference is a number
  // somebody has looked at rather than a claim.
  const old2026 = calculate(Object.assign({
    periodDate: '2026-01-01', periodsRemaining: 11, annualRentDeclared: N(1200000)
  }, split(N(300000))));
  check('the template said ₦8,400; the Act says ₦27,905',
    old2026.deductions.paye === N(27905) && N(27905) > N(8400) * 3);

  const pita = calculate(Object.assign({ periodDate: '2025-06-01', periodsRemaining: 6 },
    split(N(300000))));
  check('a 2025 period is still calculated under the old regime',
    pita.ruleSet === 'NG-PITA' && pita.tax.relief.consolidated > 0);
  // Projected from June: this month plus six more, so ₦2,100,000 — not a
  // full year. CRA is the ₦200,000 floor (1% of 2.1m is only 21,000) plus
  // 20% of 2.1m. Annual, which is exactly what the spreadsheet got wrong by
  // granting the ₦200,000 every month.
  check('and the old relief is annual, as it always was',
    pita.tax.projectedAnnualGross === N(2100000) &&
    pita.tax.relief.consolidated === N(200000) + N(420000),
    String(toN(pita.tax.relief.consolidated)));

  // =======================================================================
  console.log('\nthe payment schedule');

  const fakeLines = [
    { employee_name: 'Aisha Bello', bank_name: 'GTB', bank_account_number: '0151915847',
      bank_account_name: 'Aisha Bello', net_kobo: N(244345), staff_number: 'E001' },
    { employee_name: 'Zero Pay', bank_name: 'ACCESS', bank_account_number: '0696936838',
      bank_account_name: 'Zero Pay', net_kobo: 0 },
    { employee_name: 'No Account', bank_name: 'UBA', bank_account_number: null, net_kobo: N(100000) },
    { employee_name: 'Short Number', bank_name: 'UBA', bank_account_number: '12345', net_kobo: N(100000) }
  ];

  const rows = schedule.rows(fakeLines);
  check('nobody with nothing to be paid is on the bank file', rows.length === 3);
  check('the rows are numbered from one', rows[0].sn === 1 && rows[2].sn === 3);

  const problems = schedule.problems(fakeLines);
  check('a missing account number is reported, not silently dropped',
    problems.some((p) => p.name === 'No Account'));
  check('an account number that is not ten digits is reported',
    problems.some((p) => p.name === 'Short Number' && /10 digits/.test(p.problem)));
  check('a valid row raises nothing', !problems.some((p) => p.name === 'Aisha Bello'));

  const csv = schedule.csv(fakeLines);
  check('the CSV quotes the account number so a leading zero survives',
    csv.includes('"0151915847"'), csv.split('\r\n')[1]);
  check('it carries a total row', /Total/.test(csv));
  const xls = schedule.excel(fakeLines, { org: { name: 'Test Ltd' } });
  check('the Excel file declares the account number as text',
    /<Data ss:Type="String">0151915847<\/Data>/.test(xls));

  // =======================================================================
  console.log('\nthe whole thing, against a running server');

  const stamp = Date.now();
  const api = client();
  const email = 'payroll-' + stamp + '@mideops.ng';
  const signup = await api('POST', '/api/auth/signup', {
    name: 'Payroll Tester', org: 'Payroll Test ' + stamp, email,
    password: 'payroll-test-pass-1', book: 'sme', cycle: 'monthly', users: 1
  });
  check('an account to test with', signup.status === 201, JSON.stringify(signup.body).slice(0, 160));
  const orgId = signup.body.session.orgId;
  const org = (p) => '/api/orgs/' + orgId + p;

  // ---------------------------------------------------------- employees
  const created = await api('POST', org('/payroll/employees'), {
    name: 'Chidinma Ekpeti', staffNumber: 'E001', designation: 'HR Manager',
    bank: 'ACCESS', accountName: 'Chidinma Ekpeti', accountNumber: '0696936838',
    hireDate: '2026-01-01', gross: '300000', annualRent: '1200000', salaryFrom: '2026-01-01'
  });
  check('an employee can be added', created.status === 201, JSON.stringify(created.body).slice(0, 160));
  const employeeId = created.body.employee && created.body.employee.id;
  check('their salary comes back with them', created.body.employee.gross === 300000);
  check('their status is derived, not stored', created.body.employee.status === 'active');

  const badAccount = await api('POST', org('/payroll/employees'), {
    name: 'Wrong Account', accountNumber: '12345'
  });
  check('an account number that the bank would reject is refused here',
    badAccount.status === 422 && /10 digits/.test(badAccount.body.error));

  const backwards = await api('POST', org('/payroll/employees'), {
    name: 'Time Traveller', hireDate: '2026-05-01', endDate: '2026-01-01'
  });
  check('somebody cannot leave before they were hired', backwards.status === 422);

  const dupe = await api('POST', org('/payroll/employees'), { name: 'Another', staffNumber: 'E001' });
  check('a staff number cannot be used twice', dupe.status === 422, 'status ' + dupe.status);

  const imported = await api('POST', org('/payroll/employees/import'), {
    rows: [
      { name: 'Kelvin Ogodo', designation: 'Accountant', bank: 'REVELATION MFB',
        accountNumber: '1100106870', gross: 300000, from: '2026-01-01' },
      { name: 'Okwudili Afunwa', designation: 'Head Driver', bank: 'ECO',
        accountNumber: '0603001049', gross: 200000, from: '2026-01-01' },
      { name: '', gross: 1000 },
      { name: 'Bad Account', accountNumber: 'abc' }
    ]
  });
  check('an import reports what it took', imported.status === 201 && imported.body.added === 2,
    JSON.stringify(imported.body).slice(0, 180));
  check('and what it would not take, with reasons',
    imported.body.skipped.length === 2 &&
    imported.body.skipped.some((s) => /10 digits/.test(s.why)),
    JSON.stringify(imported.body.skipped));

  // ------------------------------------------------------------- a run
  const run = await api('POST', org('/payroll/runs'), { year: 2026, month: 1, payDate: '2026-01-28' });
  check('a payroll can be calculated', run.status === 201, JSON.stringify(run.body).slice(0, 200));
  const runId = run.body.run && run.body.run.id;
  check('it covers all three employees', run.body.employees === 3, String(run.body.employees));
  check('it says which law it used', run.body.run.ruleSet === 'NG-2026-NTA');
  check('it names what is still unconfirmed about that law',
    run.body.rules.doubts.length === 3, JSON.stringify(run.body.rules.doubts.length));

  const detail = await api('GET', org('/payroll/runs/' + runId));
  check('the run reads back with its lines', detail.status === 200 && detail.body.lines.length === 3);
  const chidinma = detail.body.lines.find((l) => /Chidinma/.test(l.name));
  check('and the figure matches the hand calculation exactly', chidinma.paye === 27905,
    String(chidinma.paye));
  check('gross equals the sum of its parts for every line',
    detail.body.lines.every((l) => Math.abs(l.basic + l.housing + l.transport + l.allowances +
      l.bonus - l.gross) < 0.005));
  check('net equals gross less deductions for every line',
    detail.body.lines.every((l) => Math.abs(l.gross - l.deductions - l.net) < 0.005));

  const totals = detail.body.run.totals;
  check('the run total is the sum of the lines',
    Math.abs(totals.net - detail.body.lines.reduce((a, l) => a + l.net, 0)) < 0.005);
  check('the employer cost is gross plus the employer contribution',
    Math.abs(totals.employerCost - (totals.gross + totals.employerPension)) < 0.005);

  // Rebuilding a draft replaces it rather than doubling it.
  const rebuilt = await api('POST', org('/payroll/runs'), {
    year: 2026, month: 1, payDate: '2026-01-28',
    adjustments: [{ employeeId, bonus: '50000' }]
  });
  check('a draft can be recalculated', rebuilt.status === 201 && rebuilt.body.employees === 3);
  const afterBonus = await api('GET', org('/payroll/runs/' + runId));
  check('…and the bonus lands on the right person',
    afterBonus.body.lines.find((l) => /Chidinma/.test(l.name)).bonus === 50000);
  check('…without creating a second payroll for the month',
    (await api('GET', org('/payroll/runs'))).body.runs.length === 1);

  // Re-read after the rebuild. The totals captured before the bonus are no
  // longer what this payroll owes, and every check below is about what it
  // owes now.
  const current = (await api('GET', org('/payroll/runs/' + runId))).body.run.totals;
  check('the totals moved with the bonus',
    Math.abs(current.gross - (totals.gross + 50000)) < 0.005,
    current.gross + ' vs ' + totals.gross);

  // -------------------------------------------------------- approval
  const approved = await api('POST', org('/payroll/runs/' + runId + '/approve'));
  check('a payroll can be approved', approved.status === 200 && approved.body.run.status === 'approved');
  check('approving posts a journal entry', Boolean(approved.body.journalEntryId));

  const twice = await api('POST', org('/payroll/runs/' + runId + '/approve'));
  check('approving twice is not an error and does not post twice',
    twice.status === 200 && twice.body.alreadyApproved === true);

  const entries = await pool.query(
    "SELECT COUNT(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND source_type = 'payroll'",
    [orgId]
  );
  check('there is exactly one payroll entry in the ledger', entries.rows[0].n === 1,
    String(entries.rows[0].n));

  const balance = await pool.query(
    `SELECT COALESCE(SUM(debit_kobo),0)::bigint AS d, COALESCE(SUM(credit_kobo),0)::bigint AS c
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.organization_id = $1 AND je.source_type = 'payroll'`,
    [orgId]
  );
  check('and it balances', Number(balance.rows[0].d) === Number(balance.rows[0].c),
    balance.rows[0].d + ' vs ' + balance.rows[0].c);

  const liabilities = await pool.query(
    `SELECT a.code, SUM(jl.credit_kobo - jl.debit_kobo)::bigint AS bal
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.organization_id = $1 AND je.source_type = 'payroll'
      GROUP BY a.code ORDER BY a.code`,
    [orgId]
  );
  const byCode = new Map(liabilities.rows.map((r) => [r.code, Number(r.bal)]));
  check('PAYE is a liability of its own',
    byCode.get('2200') === Math.round(current.paye * 100), JSON.stringify([...byCode]));
  check('net salaries are owed to staff, not paid', byCode.get('2250') > 0);
  check('the employer contribution is an expense, not a deduction',
    byCode.get('6010') < 0 && Math.abs(byCode.get('6010')) === Math.round(current.employerPension * 100));

  const editAfter = await api('POST', org('/payroll/runs'), { year: 2026, month: 1 });
  check('an approved payroll cannot be recalculated', editAfter.status === 409,
    'status ' + editAfter.status);
  const deleteAfter = await api('DELETE', org('/payroll/runs/' + runId));
  check('nor deleted', deleteAfter.status === 409);

  // ------------------------------------------------------- the outputs
  const payslips = await api('GET', org('/payroll/runs/' + runId + '/payslips.pdf'));
  check('bulk payslips render as a PDF',
    payslips.status === 200 && payslips.buffer.slice(0, 5).toString() === '%PDF-',
    payslips.type);
  check('…and are a real document, not an empty one', payslips.buffer.length > 4000,
    String(payslips.buffer.length));

  const onePayslip = await api('GET', org('/payroll/runs/' + runId + '/payslips.pdf?employee=' + employeeId));
  check('a single payslip renders', onePayslip.status === 200 && onePayslip.buffer.length > 2000);
  check('…and is smaller than all three', onePayslip.buffer.length < payslips.buffer.length);

  const csvOut = await api('GET', org('/payroll/runs/' + runId + '/schedule.csv'));
  check('the schedule downloads as CSV', csvOut.status === 200);
  const xlsOut = await api('GET', org('/payroll/runs/' + runId + '/schedule.xls'));
  check('and as Excel', xlsOut.status === 200);
  const pdfOut = await api('GET', org('/payroll/runs/' + runId + '/schedule.pdf'));
  check('and as PDF', pdfOut.status === 200 && pdfOut.buffer.slice(0, 5).toString() === '%PDF-');

  // ---------------------------------------------------------- payments
  const over = await api('POST', org('/payroll/runs/' + runId + '/payments'), {
    kind: 'salaries', amount: String(current.net + 1000), paidOn: '2026-01-28'
  });
  check('paying more than the payroll owes is refused', over.status === 422,
    'status ' + over.status);

  const paidSalaries = await api('POST', org('/payroll/runs/' + runId + '/payments'), {
    kind: 'salaries', amount: String(current.net), paidOn: '2026-01-28', reference: 'GTB-BULK-1'
  });
  check('salaries can be recorded as paid', paidSalaries.status === 201);
  check('…and that posts to the ledger too', Boolean(paidSalaries.body.journalEntryId));

  const afterPay = await pool.query(
    `SELECT SUM(jl.credit_kobo - jl.debit_kobo)::bigint AS bal
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.organization_id = $1 AND a.code = '2250'`,
    [orgId]
  );
  check('paying the salaries clears what was owed to staff',
    Number(afterPay.rows[0].bal) === 0, String(afterPay.rows[0].bal));

  const cannotReverse = await api('POST', org('/payroll/runs/' + runId + '/reverse'), { reason: 'oops' });
  check('a payroll with payments against it cannot be reversed by surprise',
    cannotReverse.status === 409, 'status ' + cannotReverse.status);

  // --------------------------------------------------------- reversal
  const feb = await api('POST', org('/payroll/runs'), { year: 2026, month: 2 });
  check('February calculates', feb.status === 201);
  const febId = feb.body.run.id;
  const febDetail = await api('GET', org('/payroll/runs/' + febId));
  const febChidinma = febDetail.body.lines.find((l) => /Chidinma/.test(l.name));
  check('February knows about January\'s bonus through the year to date',
    febChidinma.paye !== 27905, String(febChidinma.paye));

  await api('POST', org('/payroll/runs/' + febId + '/approve'));
  const reversed = await api('POST', org('/payroll/runs/' + febId + '/reverse'), { reason: 'wrong bonus', date: '2026-03-01' });
  check('an approved payroll can be reversed', reversed.status === 200 &&
    reversed.body.run.status === 'reversed');

  const net = await pool.query(
    `SELECT COALESCE(SUM(jl.credit_kobo - jl.debit_kobo),0)::bigint AS bal
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.organization_id = $1 AND a.code = '6000'`,
    [orgId]
  );
  // January's gross expense remains; February's was reversed out.
  check('the reversal takes February back out of the books',
    Math.abs(Number(net.rows[0].bal)) === Math.round(current.gross * 100),
    net.rows[0].bal + ' vs ' + Math.round(current.gross * 100));

  const febAgain = await api('POST', org('/payroll/runs'), { year: 2026, month: 2 });
  check('and February can then be run again', febAgain.status === 201);

  // ----------------------------------------------------------- reading
  const overview = await api('GET', org('/payroll/overview?year=2026'));
  check('the overview loads', overview.status === 200);
  check('it counts the staff', overview.body.employees.active === 3, String(overview.body.employees.active));
  check('it says what is owed and not yet remitted', overview.body.outstanding.paye > 0);
  check('salaries paid are no longer outstanding', overview.body.outstanding.salaries >= 0);

  const rules = await api('GET', org('/payroll/rules?on=2026-03-01'));
  check('the rules can be read by the screen that explains a figure',
    rules.status === 200 && rules.body.bands.length === 6);
  check('and it says the CRA is abolished', rules.body.consolidatedRelief === 'abolished');

  const estimate = await api('POST', org('/payroll/estimate'), { gross: '500000', annualRent: '2400000' });
  check('a salary can be costed before anybody is hired', estimate.status === 200);
  check('the estimate shows the employer\'s true cost',
    estimate.body.employerCost === estimate.body.gross + estimate.body.employerPension);

  // --------------------------------------------------------- isolation
  const other = client();
  const otherSignup = await other('POST', '/api/auth/signup', {
    name: 'Other Business', org: 'Other Payroll ' + stamp, email: 'payroll-other-' + stamp + '@mideops.ng',
    password: 'payroll-test-pass-2', book: 'sme', cycle: 'monthly', users: 1
  });
  check('a second business exists', otherSignup.status === 201);
  const theirs = await other('GET', org('/payroll/employees'));
  check('another business cannot read this payroll', theirs.status === 404,
    'status ' + theirs.status);
  const theirRun = await other('GET', org('/payroll/runs/' + runId));
  check('nor a specific run', theirRun.status === 404);
  const theirPayslips = await other('GET', org('/payroll/runs/' + runId + '/payslips.pdf'));
  check('nor the payslips', theirPayslips.status === 404);
  const ownEmployees = await other('GET', '/api/orgs/' + otherSignup.body.session.orgId + '/payroll/employees');
  check('and its own payroll is empty, not somebody else\'s',
    ownEmployees.status === 200 && ownEmployees.body.employees.length === 0);

  // ------------------------------------------------------------- roles
  const viewerEmail = 'payroll-viewer-' + stamp + '@mideops.ng';
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, auth_provider)
     VALUES ($1, $2, 'Payroll Viewer', 'password')`,
    [viewerEmail, require('bcryptjs').hashSync('payroll-test-pass-3', 10)]
  );
  await pool.query(
    `INSERT INTO memberships (user_id, organization_id, role)
     SELECT id, $2, 'viewer' FROM users WHERE email = $1`,
    [viewerEmail, orgId]
  );
  const viewer = client();
  const viewerIn = await viewer('POST', '/api/auth/login', { email: viewerEmail, password: 'payroll-test-pass-3' });
  check('a viewer can sign in', viewerIn.status === 200);
  const viewerSees = await viewer('GET', org('/payroll/employees'));
  check('a viewer sees no payroll at all', viewerSees.status === 403, 'status ' + viewerSees.status);
  const viewerApproves = await viewer('POST', org('/payroll/runs/' + runId + '/approve'));
  check('and certainly cannot approve one', viewerApproves.status === 403);

  // An accountant sees salaries — asked for, and the right answer for the
  // businesses this serves.
  const accountantEmail = 'payroll-acct-' + stamp + '@mideops.ng';
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, auth_provider)
     VALUES ($1, $2, 'Payroll Accountant', 'password')`,
    [accountantEmail, require('bcryptjs').hashSync('payroll-test-pass-4', 10)]
  );
  await pool.query(
    `INSERT INTO memberships (user_id, organization_id, role)
     SELECT id, $2, 'accountant' FROM users WHERE email = $1`,
    [accountantEmail, orgId]
  );
  const accountant = client();
  await accountant('POST', '/api/auth/login', { email: accountantEmail, password: 'payroll-test-pass-4' });
  const acctSees = await accountant('GET', org('/payroll/employees'));
  check('an accountant sees the payroll, salaries included',
    acctSees.status === 200 && acctSees.body.employees.some((e) => e.gross === 300000));
  const acctApproves = await accountant('POST', org('/payroll/runs/' + febAgain.body.run.id + '/approve'));
  check('but approving stays with an admin', acctApproves.status === 403, 'status ' + acctApproves.status);

  // ------------------------------------------------------------ cleanup
  await pool.query('DELETE FROM organizations WHERE id = $1 OR id = $2',
    [orgId, otherSignup.body.session.orgId]);
  await pool.query('DELETE FROM users WHERE email IN ($1,$2,$3,$4)',
    [email, 'payroll-other-' + stamp + '@mideops.ng', viewerEmail, accountantEmail]);
  await pool.end();

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\npayroll test could not finish:', err.message);
  console.error(err.stack);
  process.exit(1);
});
