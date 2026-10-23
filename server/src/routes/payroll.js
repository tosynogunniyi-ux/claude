// Payroll: employees, salaries, runs, payslips and schedules.
//
// Mounted inside the org-scoped router, so requireOrg has already decided
// that this caller belongs to these books. Every query carries req.orgId
// regardless, because a single choke point is a policy and a scoped query is
// a guarantee.
//
// On who may see what: an accountant sees salaries. That was asked for and it
// is the right answer for the businesses this serves, where the person who
// runs payroll and the person who keeps the books are usually the same
// person and often an external accountant. A viewer sees nothing here at all
// — not a redacted payroll, nothing — because a half-hidden payroll invites
// the inference that the blanks are large numbers.
//
// Approving and reversing are admin-only. Calculating a payroll is work;
// approving one is a commitment that posts to the ledger.

const express = require('express');
const { one, many, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const money = require('../money');
const statutory = require('../payroll/statutory');
const runs = require('../payroll/run');
const payslip = require('../payroll/payslip');
const schedule = require('../payroll/schedule');
const { calculate, split, DEFAULT_STRUCTURE } = require('../payroll/calculate');
const { NAMES } = require('../invoicing/themes');

const router = express.Router({ mergeParams: true });

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function reply(res, err, next) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return next(err);
}

const bad = (res, message) => res.status(422).json({ error: message });

// Money arrives from the browser as naira text and is parsed by moving the
// decimal point, never by multiplying. The whole product does this.
const kobo = (v) => money.toKobo(v);

// -------------------------------------------------------------- employees

function shapeEmployee(row) {
  const ended = row.end_date && String(row.end_date) <= today();
  return {
    id: row.id,
    staffNumber: row.staff_number,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    department: row.department,
    designation: row.designation,
    hireDate: row.hire_date,
    endDate: row.end_date,
    // Derived, never stored: a status column and a leaving date are two
    // places for the same fact to live and one of them is always stale.
    status: row.suspended_at ? 'suspended' : ended ? 'left' : 'active',
    stateOfResidence: row.state_of_residence,
    tin: row.tin,
    bank: row.bank_name,
    accountName: row.bank_account_name,
    accountNumber: row.bank_account_number,
    pensionExempt: row.pension_exempt,
    rsaPin: row.rsa_pin,
    pfa: row.pfa_name,
    employerPensionBp: row.employer_pension_bp,
    nhfExempt: row.nhf_exempt,
    annualRent: money.toNaira(row.annual_rent_kobo),
    rentDeclaredAt: row.rent_declared_at,
    notes: row.notes,
    gross: row.gross_monthly_kobo === null || row.gross_monthly_kobo === undefined
      ? null : money.toNaira(row.gross_monthly_kobo),
    salaryFrom: row.effective_from || null
  };
}

const WITH_SALARY = `
  SELECT e.*, s.gross_monthly_kobo, s.effective_from
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT * FROM employee_salaries sal
       WHERE sal.employee_id = e.id AND sal.effective_from <= CURRENT_DATE
       ORDER BY sal.effective_from DESC LIMIT 1
    ) s ON true
   WHERE e.organization_id = $1`;

router.get('/payroll/employees', requireOrg('accountant'), async (req, res, next) => {
  try {
    const rows = await many(WITH_SALARY + ' ORDER BY e.full_name', [req.orgId]);
    const list = rows.map(shapeEmployee);
    res.json({
      employees: list,
      active: list.filter((e) => e.status === 'active').length,
      note: list.length ? null : 'No employees yet. Add one, or import a list from Excel.'
    });
  } catch (err) { next(err); }
});

router.get('/payroll/employees/:id', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await one(WITH_SALARY + ' AND e.id = $2', [req.orgId, req.params.id]);
    if (!row) return res.status(404).json({ error: 'No such employee.' });
    const history = await many(
      `SELECT effective_from, gross_monthly_kobo, reason, created_at
         FROM employee_salaries WHERE employee_id = $1 ORDER BY effective_from DESC`,
      [req.params.id]
    );
    const payslips = await many(
      `SELECT l.id, l.gross_kobo, l.net_kobo, l.paye_kobo, r.period_year, r.period_month, r.status
         FROM pay_run_lines l JOIN pay_runs r ON r.id = l.pay_run_id
        WHERE l.organization_id = $1 AND l.employee_id = $2 AND r.status <> 'reversed'
        ORDER BY r.period_year DESC, r.period_month DESC LIMIT 24`,
      [req.orgId, req.params.id]
    );
    res.json({
      employee: shapeEmployee(row),
      salaryHistory: history.map((h) => ({
        from: h.effective_from, gross: money.toNaira(h.gross_monthly_kobo), reason: h.reason
      })),
      payslips: payslips.map((p) => ({
        lineId: p.id,
        period: p.period_year + '-' + String(p.period_month).padStart(2, '0'),
        gross: money.toNaira(p.gross_kobo),
        paye: money.toNaira(p.paye_kobo),
        net: money.toNaira(p.net_kobo),
        status: p.status
      }))
    });
  } catch (err) { next(err); }
});

// Create or update. Admin only: adding somebody to the payroll is adding
// somebody to the bank file.
async function saveEmployee(req, res, next) {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'An employee needs a name.');
    if (b.hireDate && !isDate(b.hireDate)) return bad(res, 'Give the hire date as YYYY-MM-DD.');
    if (b.endDate && !isDate(b.endDate)) return bad(res, 'Give the leaving date as YYYY-MM-DD.');
    if (b.hireDate && b.endDate && String(b.endDate) < String(b.hireDate)) {
      return bad(res, 'Somebody cannot leave before they were hired.');
    }
    const account = String(b.accountNumber || '').trim();
    if (account && !/^\d{10}$/.test(account)) {
      return bad(res, 'A Nigerian account number is 10 digits. The bank will reject anything else.');
    }

    const fields = [name, b.staffNumber || null, b.email || null, b.phone || null,
      b.department || null, b.designation || null, b.hireDate || null, b.endDate || null,
      b.stateOfResidence || null, b.tin || null, b.bank || null, b.accountName || null,
      account || null, Boolean(b.pensionExempt), b.rsaPin || null, b.pfa || null,
      b.employerPensionBp === undefined || b.employerPensionBp === null || b.employerPensionBp === ''
        ? null : int(b.employerPensionBp),
      Boolean(b.nhfExempt), kobo(b.annualRent), b.notes || null];

    let row;
    if (req.params.id) {
      row = await one(
        `UPDATE employees SET full_name = $3, staff_number = $4, email = $5, phone = $6,
                department = $7, designation = $8, hire_date = $9, end_date = $10,
                state_of_residence = $11, tin = $12, bank_name = $13, bank_account_name = $14,
                bank_account_number = $15, pension_exempt = $16, rsa_pin = $17, pfa_name = $18,
                employer_pension_bp = $19, nhf_exempt = $20, annual_rent_kobo = $21,
                -- Cast, because the same parameter is also assigned to a
                -- bigint column above and Postgres will not deduce two types
                -- for one placeholder.
                rent_declared_at = CASE WHEN $21::bigint > 0 AND annual_rent_kobo <> $21::bigint
                                        THEN now() ELSE rent_declared_at END,
                notes = $22
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [req.orgId, req.params.id, ...fields]
      );
      if (!row) return res.status(404).json({ error: 'No such employee.' });
    } else {
      row = await one(
        `INSERT INTO employees
           (organization_id, full_name, staff_number, email, phone, department, designation,
            hire_date, end_date, state_of_residence, tin, bank_name, bank_account_name,
            bank_account_number, pension_exempt, rsa_pin, pfa_name, employer_pension_bp,
            nhf_exempt, annual_rent_kobo, notes, rent_declared_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 CASE WHEN $20::bigint > 0 THEN now() ELSE NULL END)
         RETURNING *`,
        [req.orgId, ...fields]
      );
    }

    // A salary given at the same time becomes the first effective-dated row.
    if (b.gross !== undefined && b.gross !== null && b.gross !== '') {
      await query(
        `INSERT INTO employee_salaries
           (organization_id, employee_id, effective_from, gross_monthly_kobo, structure_id,
            other_allowances_kobo, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (employee_id, effective_from)
         DO UPDATE SET gross_monthly_kobo = EXCLUDED.gross_monthly_kobo,
                       structure_id = EXCLUDED.structure_id,
                       other_allowances_kobo = EXCLUDED.other_allowances_kobo`,
        [req.orgId, row.id, b.salaryFrom && isDate(b.salaryFrom) ? b.salaryFrom : today(),
          kobo(b.gross), b.structureId || null, kobo(b.otherAllowances), b.salaryReason || null,
          req.user.id]
      );
    }

    await audit(req.orgId, req.user.id, req.params.id ? 'payroll.employee.updated' : 'payroll.employee.created',
      'employee', row.id, { name: row.full_name });

    const full = await one(WITH_SALARY + ' AND e.id = $2', [req.orgId, row.id]);
    res.status(req.params.id ? 200 : 201).json({ employee: shapeEmployee(full) });
  } catch (err) {
    if (err && err.code === '23505') {
      return bad(res, 'Another employee already has that staff number.');
    }
    next(err);
  }
}

router.post('/payroll/employees', requireOrg('admin'), saveEmployee);
router.patch('/payroll/employees/:id', requireOrg('admin'), saveEmployee);

// A raise, or any salary change, as its own dated record.
router.post('/payroll/employees/:id/salary', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const from = isDate(b.from) ? b.from : today();
    const employee = await one(
      'SELECT id, full_name FROM employees WHERE organization_id = $1 AND id = $2',
      [req.orgId, req.params.id]
    );
    if (!employee) return res.status(404).json({ error: 'No such employee.' });
    if (b.gross === undefined || b.gross === null || b.gross === '') {
      return bad(res, 'A salary change needs an amount.');
    }
    await query(
      `INSERT INTO employee_salaries
         (organization_id, employee_id, effective_from, gross_monthly_kobo, structure_id,
          basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (employee_id, effective_from) DO UPDATE
         SET gross_monthly_kobo = EXCLUDED.gross_monthly_kobo,
             structure_id = EXCLUDED.structure_id,
             basic_kobo = EXCLUDED.basic_kobo,
             housing_kobo = EXCLUDED.housing_kobo,
             transport_kobo = EXCLUDED.transport_kobo,
             other_allowances_kobo = EXCLUDED.other_allowances_kobo,
             reason = EXCLUDED.reason`,
      [req.orgId, employee.id, from, kobo(b.gross), b.structureId || null,
        b.basic === undefined || b.basic === '' ? null : kobo(b.basic),
        b.housing === undefined || b.housing === '' ? null : kobo(b.housing),
        b.transport === undefined || b.transport === '' ? null : kobo(b.transport),
        kobo(b.otherAllowances), b.reason || null, req.user.id]
    );
    await audit(req.orgId, req.user.id, 'payroll.salary.changed', 'employee', employee.id,
      { from, gross: b.gross, reason: b.reason || null });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// Importing a list. Rows in, a report out — never a partial import that
// leaves somebody wondering which half landed.
router.post('/payroll/employees/import', requireOrg('admin'), async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!incoming) return bad(res, 'Send { rows: [...] }.');
    if (incoming.length > 1000) return bad(res, 'That is more than 1,000 rows. Split the file.');

    const added = [];
    const skipped = [];
    for (const r of incoming) {
      const name = String(r.name || r['Employee Name'] || '').trim();
      if (!name) { skipped.push({ row: r, why: 'no name' }); continue; }
      const account = String(r.accountNumber || r['Account Number'] || '').trim();
      if (account && !/^\d{10}$/.test(account)) {
        skipped.push({ name, why: 'account number is not 10 digits' });
        continue;
      }
      try {
        const employee = await one(
          `INSERT INTO employees
             (organization_id, full_name, staff_number, designation, department,
              bank_name, bank_account_name, bank_account_number, email, phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, full_name`,
          [req.orgId, name, r.staffNumber || null, r.designation || r['Designation'] || null,
            r.department || null, r.bank || r['Bank Name'] || null,
            r.accountName || name, account || null, r.email || null, r.phone || null]
        );
        const gross = r.gross !== undefined ? r.gross : r['Gross Salary'];
        if (gross !== undefined && gross !== null && gross !== '') {
          await query(
            `INSERT INTO employee_salaries
               (organization_id, employee_id, effective_from, gross_monthly_kobo, reason, created_by)
             VALUES ($1,$2,$3,$4,'Imported',$5)
             ON CONFLICT (employee_id, effective_from) DO NOTHING`,
            [req.orgId, employee.id, isDate(r.from) ? r.from : today(), kobo(gross), req.user.id]
          );
        }
        added.push(employee.full_name);
      } catch (err) {
        skipped.push({ name, why: err.code === '23505' ? 'that staff number is already used' : 'could not be saved' });
      }
    }

    await audit(req.orgId, req.user.id, 'payroll.employees.imported', 'employee', null,
      { added: added.length, skipped: skipped.length });
    res.status(201).json({ added: added.length, skipped, names: added });
  } catch (err) { next(err); }
});

// ------------------------------------------------------ salary structures

router.get('/payroll/structures', requireOrg('accountant'), async (req, res, next) => {
  try {
    const rows = await many(
      'SELECT * FROM salary_structures WHERE organization_id = $1 ORDER BY is_default DESC, name',
      [req.orgId]
    );
    res.json({
      structures: rows.map((r) => ({
        id: r.id, name: r.name,
        basic: r.basic_bp / 100, housing: r.housing_bp / 100, transport: r.transport_bp / 100,
        isDefault: r.is_default
      })),
      // What is used when a business has not set one up. Said plainly rather
      // than left as a surprise in the first payroll.
      fallback: {
        name: '50 / 30 / 20', basic: 50, housing: 30, transport: 20,
        why: 'The split most Nigerian businesses use. It matters because pension is ' +
          'contributed on basic, housing and transport — not on gross.'
      }
    });
  } catch (err) { next(err); }
});

router.post('/payroll/structures', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'A structure needs a name.');
    const basic = Math.round(Number(b.basic) * 100);
    const housing = Math.round(Number(b.housing) * 100);
    const transport = Math.round(Number(b.transport) * 100);
    if (![basic, housing, transport].every(Number.isFinite)) {
      return bad(res, 'Give basic, housing and transport as percentages.');
    }
    if (basic + housing + transport !== 10000) {
      return bad(res, 'The three parts have to add up to 100%. Yours come to ' +
        ((basic + housing + transport) / 100).toFixed(2) + '%.');
    }
    if (b.isDefault) {
      await query('UPDATE salary_structures SET is_default = false WHERE organization_id = $1', [req.orgId]);
    }
    const row = await one(
      `INSERT INTO salary_structures (organization_id, name, basic_bp, housing_bp, transport_bp, is_default)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.orgId, name, basic, housing, transport, Boolean(b.isDefault)]
    );
    await audit(req.orgId, req.user.id, 'payroll.structure.created', 'salary_structure', row.id, { name });
    res.status(201).json({ structure: { id: row.id, name: row.name } });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------- the runs

const shapeRun = (r, totals) => ({
  id: r.id,
  year: r.period_year,
  month: r.period_month,
  period: runs.labelOf(r.period_year, r.period_month),
  periodDate: r.period_date,
  payDate: r.pay_date,
  status: r.status,
  ruleSet: r.rule_set,
  approvedAt: r.approved_at,
  reversedAt: r.reversed_at,
  journalEntryId: r.journal_entry_id,
  totals: totals ? {
    employees: totals.employees,
    gross: money.toNaira(totals.gross),
    paye: money.toNaira(totals.paye),
    employeePension: money.toNaira(totals.employeePension),
    employerPension: money.toNaira(totals.employerPension),
    nhf: money.toNaira(totals.nhf),
    deductions: money.toNaira(totals.deductions),
    net: money.toNaira(totals.net),
    employerCost: money.toNaira(totals.employerCost)
  } : null
});

router.get('/payroll/runs', requireOrg('accountant'), async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM pay_run_lines l WHERE l.pay_run_id = r.id) AS n,
              (SELECT COALESCE(SUM(l.gross_kobo),0)::bigint FROM pay_run_lines l WHERE l.pay_run_id = r.id) AS gross,
              (SELECT COALESCE(SUM(l.net_kobo),0)::bigint FROM pay_run_lines l WHERE l.pay_run_id = r.id) AS net,
              (SELECT COALESCE(SUM(l.paye_kobo),0)::bigint FROM pay_run_lines l WHERE l.pay_run_id = r.id) AS paye
         FROM pay_runs r WHERE r.organization_id = $1
        ORDER BY r.period_year DESC, r.period_month DESC LIMIT 36`,
      [req.orgId]
    );
    res.json({
      runs: rows.map((r) => Object.assign(shapeRun(r), {
        employees: r.n,
        gross: money.toNaira(r.gross),
        net: money.toNaira(r.net),
        paye: money.toNaira(r.paye)
      }))
    });
  } catch (err) { next(err); }
});

router.get('/payroll/runs/:id', requireOrg('accountant'), async (req, res, next) => {
  try {
    const d = await runs.detail(req.orgId, req.params.id);
    if (!d) return res.status(404).json({ error: 'No such payroll.' });
    res.json({
      run: shapeRun(d.run, d.totals),
      rules: d.rules,
      lines: d.lines.map((l) => ({
        id: l.id,
        employeeId: l.employee_id,
        name: l.employee_name,
        staffNumber: l.staff_number,
        designation: l.designation,
        bank: l.bank_name,
        accountNumber: l.bank_account_number,
        basic: money.toNaira(l.basic_kobo),
        housing: money.toNaira(l.housing_kobo),
        transport: money.toNaira(l.transport_kobo),
        allowances: money.toNaira(l.other_allowances_kobo),
        bonus: money.toNaira(l.bonus_kobo),
        gross: money.toNaira(l.gross_kobo),
        pension: money.toNaira(l.employee_pension_kobo),
        employerPension: money.toNaira(l.employer_pension_kobo),
        nhf: money.toNaira(l.nhf_kobo),
        paye: money.toNaira(l.paye_kobo),
        otherDeductions: money.toNaira(l.other_deductions_kobo),
        deductions: money.toNaira(l.total_deductions_kobo),
        net: money.toNaira(l.net_kobo),
        tax: l.tax_detail
      })),
      payments: d.payments.map((p) => ({
        id: p.id, kind: p.kind, amount: money.toNaira(p.amount_kobo),
        paidOn: p.paid_on, reference: p.reference
      })),
      // What the bank would refuse, said before the file is downloaded.
      problems: schedule.problems(d.lines)
    });
  } catch (err) { next(err); }
});

// Build or rebuild a draft.
router.post('/payroll/runs', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const year = int(b.year);
    const month = int(b.month);
    if (!(year >= 2000 && year <= 2200) || !(month >= 1 && month <= 12)) {
      return bad(res, 'Give a year and a month between 1 and 12.');
    }
    if (b.payDate && !isDate(b.payDate)) return bad(res, 'Give the pay date as YYYY-MM-DD.');

    const out = await runs.build(req.orgId, {
      year, month, payDate: b.payDate, userId: req.user.id,
      adjustments: Array.isArray(b.adjustments) ? b.adjustments.map((a) => ({
        employeeId: a.employeeId,
        bonus: kobo(a.bonus), commission: kobo(a.commission), overtime: kobo(a.overtime),
        allowance: kobo(a.allowance), otherIrregular: kobo(a.otherIrregular),
        deduction: kobo(a.deduction)
      })) : []
    });

    await audit(req.orgId, req.user.id, 'payroll.run.calculated', 'pay_run', out.run.id,
      { period: runs.labelOf(year, month), employees: out.lines.length });

    const d = await runs.detail(req.orgId, out.run.id);
    res.status(201).json({ run: shapeRun(d.run, d.totals), rules: d.rules, employees: d.lines.length });
  } catch (err) { reply(res, err, next); }
});

router.post('/payroll/runs/:id/approve', requireOrg('admin'), async (req, res, next) => {
  try {
    const out = await runs.approve(req.orgId, req.params.id, req.user.id);
    if (!out.alreadyApproved) {
      await audit(req.orgId, req.user.id, 'payroll.run.approved', 'pay_run', out.run.id, {
        period: runs.labelOf(out.run.period_year, out.run.period_month),
        net: money.toNaira(out.totals.net)
      });
    }
    res.json({
      run: shapeRun(out.run, out.totals),
      alreadyApproved: out.alreadyApproved,
      journalEntryId: out.entryId || out.run.journal_entry_id
    });
  } catch (err) { reply(res, err, next); }
});

router.post('/payroll/runs/:id/reverse', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.date && !isDate(b.date)) return bad(res, 'Give the reversal date as YYYY-MM-DD.');
    const out = await runs.reverseRun(req.orgId, req.params.id, {
      userId: req.user.id, reason: b.reason, date: b.date
    });
    if (!out.alreadyReversed) {
      await audit(req.orgId, req.user.id, 'payroll.run.reversed', 'pay_run', out.run.id, { reason: b.reason || null });
    }
    res.json({ run: shapeRun(out.run), alreadyReversed: out.alreadyReversed });
  } catch (err) { reply(res, err, next); }
});

router.delete('/payroll/runs/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const out = await runs.discard(req.orgId, req.params.id);
    await audit(req.orgId, req.user.id, 'payroll.run.discarded', 'pay_run', req.params.id, {});
    res.json(out);
  } catch (err) { reply(res, err, next); }
});

router.post('/payroll/runs/:id/payments', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const kinds = ['salaries', 'paye', 'pension', 'nhf', 'other'];
    if (!kinds.includes(b.kind)) return bad(res, 'Kind must be one of: ' + kinds.join(', ') + '.');
    if (!isDate(b.paidOn)) return bad(res, 'Give the payment date as YYYY-MM-DD.');
    const out = await runs.recordPayment(req.orgId, req.params.id, {
      kind: b.kind, amountKobo: kobo(b.amount), paidOn: b.paidOn,
      bankAccountId: b.bankAccountId, reference: b.reference, note: b.note, userId: req.user.id
    });
    await audit(req.orgId, req.user.id, 'payroll.payment.recorded', 'pay_run', req.params.id,
      { kind: b.kind, amount: b.amount });
    res.status(201).json({
      payment: { id: out.payment.id, kind: out.payment.kind, amount: money.toNaira(out.payment.amount_kobo) },
      journalEntryId: out.entryId
    });
  } catch (err) { reply(res, err, next); }
});

// --------------------------------------------------------------- payslips

// Only the columns a document needs. The logo is bytes and there is no
// reason to drag the rest of the row through for it.
const orgFor = (orgId) => one(
  'SELECT id, name, state, logo, logo_mime FROM organizations WHERE id = $1', [orgId]
);

// Payslips have no stored template of their own — an invoice carries one
// because a business may want a different look per customer, and a payslip
// never does. A caller may still name one, which is what the Settings
// preview uses.
const templateFrom = (req) => (NAMES.includes(req.query.template) ? req.query.template : undefined);

router.get('/payroll/runs/:id/payslips.pdf', requireOrg('accountant'), async (req, res, next) => {
  try {
    const d = await runs.detail(req.orgId, req.params.id);
    if (!d) return res.status(404).json({ error: 'No such payroll.' });

    const only = req.query.employee ? String(req.query.employee) : null;
    const lines = only ? d.lines.filter((l) => l.employee_id === only || l.id === only) : d.lines;
    if (!lines.length) return res.status(404).json({ error: 'No payslip for that employee in this payroll.' });

    const [org, settings] = await Promise.all([
      orgFor(req.orgId),
      one('SELECT * FROM payroll_settings WHERE organization_id = $1', [req.orgId])
    ]);

    const buffer = await payslip.render({ org, run: d.run, lines, settings, themeName: templateFrom(req) });
    const name = 'payslip-' + d.label + (only ? '-' + lines[0].employee_name.replace(/\W+/g, '-') : 's') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name.toLowerCase() + '"');
    res.send(buffer);
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------ payment schedule

router.get('/payroll/runs/:id/schedule.:format', requireOrg('accountant'), async (req, res, next) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    if (!['csv', 'xls', 'pdf'].includes(format)) {
      return bad(res, 'The schedule comes as csv, xls or pdf.');
    }
    const d = await runs.detail(req.orgId, req.params.id);
    if (!d) return res.status(404).json({ error: 'No such payroll.' });

    const base = 'salary-schedule-' + d.label;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.csv"');
      return res.send(schedule.csv(d.lines));
    }
    const org = await orgFor(req.orgId);
    if (format === 'xls') {
      res.setHeader('Content-Type', 'application/vnd.ms-excel');
      res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.xls"');
      return res.send(schedule.excel(d.lines, { org, run: d.run }));
    }
    const buffer = await schedule.pdf({ org, run: d.run, lines: d.lines, themeName: templateFrom(req) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.pdf"');
    return res.send(buffer);
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------------- the numbers

router.get('/payroll/overview', requireOrg('accountant'), async (req, res, next) => {
  try {
    const year = int(req.query.year) || Number(today().slice(0, 4));
    const [staff, latest, yearRows, outstanding] = await Promise.all([
      one(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE suspended_at IS NULL
                        AND (end_date IS NULL OR end_date >= CURRENT_DATE))::int AS active
             FROM employees WHERE organization_id = $1`, [req.orgId]),
      one(`SELECT * FROM pay_runs WHERE organization_id = $1 AND status <> 'reversed'
            ORDER BY period_year DESC, period_month DESC LIMIT 1`, [req.orgId]),
      many(
        `SELECT r.period_month,
                COALESCE(SUM(l.gross_kobo),0)::bigint AS gross,
                COALESCE(SUM(l.net_kobo),0)::bigint AS net,
                COALESCE(SUM(l.paye_kobo),0)::bigint AS paye,
                COALESCE(SUM(l.employee_pension_kobo + l.employer_pension_kobo),0)::bigint AS pension,
                COALESCE(SUM(l.nhf_kobo),0)::bigint AS nhf,
                COALESCE(SUM(l.employer_pension_kobo),0)::bigint AS employer
           FROM pay_runs r LEFT JOIN pay_run_lines l ON l.pay_run_id = r.id
          WHERE r.organization_id = $1 AND r.period_year = $2 AND r.status <> 'reversed'
          GROUP BY r.period_month ORDER BY r.period_month`,
        [req.orgId, year]
      ),
      // What has been approved but not yet paid, per kind. The question a
      // business actually asks of a payroll screen.
      many(
        `SELECT r.id, r.period_year, r.period_month,
                COALESCE(SUM(l.net_kobo),0)::bigint  AS net,
                COALESCE(SUM(l.paye_kobo),0)::bigint AS paye,
                COALESCE(SUM(l.employee_pension_kobo + l.employer_pension_kobo),0)::bigint AS pension,
                COALESCE(SUM(l.nhf_kobo),0)::bigint  AS nhf,
                (SELECT COALESCE(SUM(p.amount_kobo),0)::bigint FROM payroll_payments p
                  WHERE p.pay_run_id = r.id AND p.kind = 'salaries') AS paid_salaries,
                (SELECT COALESCE(SUM(p.amount_kobo),0)::bigint FROM payroll_payments p
                  WHERE p.pay_run_id = r.id AND p.kind = 'paye') AS paid_paye,
                (SELECT COALESCE(SUM(p.amount_kobo),0)::bigint FROM payroll_payments p
                  WHERE p.pay_run_id = r.id AND p.kind = 'pension') AS paid_pension,
                (SELECT COALESCE(SUM(p.amount_kobo),0)::bigint FROM payroll_payments p
                  WHERE p.pay_run_id = r.id AND p.kind = 'nhf') AS paid_nhf
           FROM pay_runs r JOIN pay_run_lines l ON l.pay_run_id = r.id
          WHERE r.organization_id = $1 AND r.status IN ('approved', 'paid')
          GROUP BY r.id ORDER BY r.period_year DESC, r.period_month DESC LIMIT 24`,
        [req.orgId]
      )
    ]);

    const due = { salaries: 0, paye: 0, pension: 0, nhf: 0 };
    for (const r of outstanding) {
      due.salaries += Math.max(0, Number(r.net) - Number(r.paid_salaries));
      due.paye += Math.max(0, Number(r.paye) - Number(r.paid_paye));
      due.pension += Math.max(0, Number(r.pension) - Number(r.paid_pension));
      due.nhf += Math.max(0, Number(r.nhf) - Number(r.paid_nhf));
    }

    const sum = (key) => yearRows.reduce((a, r) => a + Number(r[key]), 0);
    const rules = statutory.rulesFor(today());

    res.json({
      year,
      employees: { total: staff.total, active: staff.active },
      latest: latest ? shapeRun(latest) : null,
      yearToDate: {
        gross: money.toNaira(sum('gross')),
        net: money.toNaira(sum('net')),
        paye: money.toNaira(sum('paye')),
        pension: money.toNaira(sum('pension')),
        nhf: money.toNaira(sum('nhf')),
        employerCost: money.toNaira(sum('gross') + sum('employer'))
      },
      months: yearRows.map((r) => ({
        month: r.period_month,
        gross: money.toNaira(r.gross),
        net: money.toNaira(r.net),
        paye: money.toNaira(r.paye)
      })),
      // Approved and not yet remitted. These are debts with deadlines.
      outstanding: {
        salaries: money.toNaira(due.salaries),
        paye: money.toNaira(due.paye),
        pension: money.toNaira(due.pension),
        nhf: money.toNaira(due.nhf)
      },
      rules: { id: rules.id, label: rules.label, note: rules.note, doubts: statutory.doubts(rules) }
    });
  } catch (err) { next(err); }
});

// What the rules say, for the screen that has to explain a figure.
router.get('/payroll/rules', requireOrg('accountant'), async (req, res, next) => {
  try {
    const on = isDate(req.query.on) ? req.query.on : today();
    const rules = statutory.rulesFor(on);
    res.json({
      id: rules.id,
      label: rules.label,
      note: rules.note,
      bands: rules.bands.map((b) => ({
        upTo: b.width === Infinity ? null : money.toNaira(b.width),
        rate: b.rateBp / 100
      })),
      pension: { employee: rules.pension.employeeBp / 100, employer: rules.pension.employerBp / 100,
        base: 'Basic, housing and transport' },
      nhf: { employee: rules.nhf.employeeBp / 100, base: 'Basic salary' },
      rentRelief: rules.rentRelief.rateBp
        ? { rate: rules.rentRelief.rateBp / 100, cap: money.toNaira(rules.rentRelief.cap) }
        : null,
      consolidatedRelief: rules.consolidatedRelief.applies ? 'applies' : 'abolished',
      minimumWageExemption: rules.minimumWageExemption.monthly
        ? money.toNaira(rules.minimumWageExemption.monthly) : null,
      doubts: statutory.doubts(rules)
    });
  } catch (err) { reply(res, err, next); }
});

// A figure before anybody is committed to it: what would this salary cost,
// and what would the employee take home?
router.post('/payroll/estimate', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const gross = kobo(b.gross);
    if (gross <= 0) return bad(res, 'Give a gross monthly salary.');
    const structure = b.basic !== undefined && b.basic !== ''
      ? { basicBp: Math.round(Number(b.basic) * 100), housingBp: Math.round(Number(b.housing) * 100),
        transportBp: Math.round(Number(b.transport) * 100) }
      : DEFAULT_STRUCTURE;
    const parts = split(gross, structure);
    const result = calculate(Object.assign({
      periodDate: isDate(b.on) ? b.on : today(),
      periodsRemaining: 11,
      annualRentDeclared: kobo(b.annualRent),
      pensionExempt: Boolean(b.pensionExempt),
      nhfExempt: Boolean(b.nhfExempt)
    }, parts));

    res.json({
      gross: money.toNaira(result.earnings.gross),
      basic: money.toNaira(result.earnings.basic),
      housing: money.toNaira(result.earnings.housing),
      transport: money.toNaira(result.earnings.transport),
      pension: money.toNaira(result.deductions.employeePension),
      nhf: money.toNaira(result.deductions.nhf),
      paye: money.toNaira(result.deductions.paye),
      net: money.toNaira(result.net),
      employerPension: money.toNaira(result.employer.pension),
      employerCost: money.toNaira(result.employer.totalCost),
      annual: {
        gross: money.toNaira(result.tax.projectedAnnualGross),
        relief: money.toNaira(result.tax.totalRelief),
        chargeable: money.toNaira(result.tax.chargeable),
        tax: money.toNaira(result.tax.annualTax)
      },
      ruleSet: result.ruleSet,
      workings: result.tax.workings.map((w) => ({
        on: money.toNaira(w.amount), rate: w.rateBp / 100, tax: money.toNaira(w.tax)
      }))
    });
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------------- settings

router.get('/payroll/settings', requireOrg('accountant'), async (req, res, next) => {
  try {
    await query('INSERT INTO payroll_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [req.orgId]);
    const s = await one('SELECT * FROM payroll_settings WHERE organization_id = $1', [req.orgId]);
    res.json({
      pensionApplies: s.pension_applies,
      nhfApplies: s.nhf_applies,
      nsitfApplies: s.nsitf_applies,
      itfApplies: s.itf_applies,
      defaultPayDay: s.default_pay_day,
      payslipNote: s.payslip_note
    });
  } catch (err) { next(err); }
});

router.patch('/payroll/settings', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = await one(
      `INSERT INTO payroll_settings (organization_id) VALUES ($1)
       ON CONFLICT (organization_id) DO UPDATE SET
         pension_applies = COALESCE($2, payroll_settings.pension_applies),
         nhf_applies     = COALESCE($3, payroll_settings.nhf_applies),
         nsitf_applies   = COALESCE($4, payroll_settings.nsitf_applies),
         itf_applies     = COALESCE($5, payroll_settings.itf_applies),
         default_pay_day = COALESCE($6, payroll_settings.default_pay_day),
         payslip_note    = COALESCE($7, payroll_settings.payslip_note)
       RETURNING *`,
      [req.orgId,
        b.pensionApplies === undefined ? null : Boolean(b.pensionApplies),
        b.nhfApplies === undefined ? null : Boolean(b.nhfApplies),
        b.nsitfApplies === undefined ? null : Boolean(b.nsitfApplies),
        b.itfApplies === undefined ? null : Boolean(b.itfApplies),
        b.defaultPayDay === undefined || b.defaultPayDay === '' ? null : int(b.defaultPayDay),
        b.payslipNote === undefined ? null : String(b.payslipNote).slice(0, 500)]
    );
    await audit(req.orgId, req.user.id, 'payroll.settings.updated', 'organization', req.orgId, {});
    res.json({ ok: true, settings: { pensionApplies: s.pension_applies, nhfApplies: s.nhf_applies } });
  } catch (err) { next(err); }
});

module.exports = { router, shapeEmployee, shapeRun };
