// A month's payroll, from draft to approved.
//
// The workflow is deliberately short and one-way:
//
//   draft      calculated, re-calculable, nothing in the books
//   approved   posted to the ledger, frozen
//   paid       the money has gone
//   reversed   undone by a mirror entry, both still visible
//
// There is no "edit an approved run". A payroll that has been approved has
// been posted, and in all probability the staff have been paid and the PAYE
// declared. Correcting it by editing would quietly change a figure somebody
// has a payslip for. Correcting it by reversing leaves both the wrong answer
// and the right one in the record, which is what an auditor needs and what
// an employee asking "why is this different from my payslip" deserves.

const { tx, one, many, query } = require('../db');
const { roundHalfUp } = require('../money');
const accounts = require('../accounting/accounts');
const posting = require('../accounting/post');
const statutory = require('./statutory');
const { calculate, split, DEFAULT_STRUCTURE } = require('./calculate');

const pad = (n) => String(n).padStart(2, '0');
const periodDateOf = (year, month) => year + '-' + pad(month) + '-01';
const labelOf = (year, month) => year + '-' + pad(month);

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function fail(message, status, code) {
  const err = new Error(message);
  // 424 rather than 5xx for a deliberate refusal: the proxy in front of this
  // app replaces a 5xx body with its own page, and the sentence is the point.
  err.status = status || 424;
  if (code) err.code = code;
  return err;
}

// --------------------------------------------------------------- the inputs

// Who should be on this payroll, and on what.
//
// An employee is included when they were employed during the month: hired on
// or before the end of it, and not gone before the start of it. A leaver in
// the middle of March is paid in March, which is both correct and the case
// every naive "status = active" query gets wrong.
async function employeesFor(client, orgId, year, month) {
  const start = periodDateOf(year, month);
  const end = lastDayOf(year, month);
  return (await client.query(
    `SELECT e.*,
            s.gross_monthly_kobo, s.basic_kobo, s.housing_kobo, s.transport_kobo,
            s.other_allowances_kobo, s.structure_id
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT * FROM employee_salaries sal
          WHERE sal.employee_id = e.id AND sal.effective_from <= $3
          ORDER BY sal.effective_from DESC LIMIT 1
       ) s ON true
      WHERE e.organization_id = $1
        AND (e.hire_date IS NULL OR e.hire_date <= $3)
        AND (e.end_date IS NULL OR e.end_date >= $2)
        AND e.suspended_at IS NULL
      ORDER BY e.full_name`,
    [orgId, start, end]
  )).rows;
}

function lastDayOf(year, month) {
  // Day 0 of the next month is the last day of this one, and the Date
  // arithmetic is on whole days so there is no timezone in it.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

// What this employee has already been paid this year, before this run.
//
// Reversed runs are excluded: a payroll that was undone did not happen, and
// counting its PAYE would under-deduct for the rest of the year.
async function ytdFor(client, orgId, employeeId, year, month) {
  // client.query, not the pooled helpers: this runs inside the transaction
  // that is building the run, and a read from a second connection would not
  // see the rows this transaction has just written.
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(l.gross_kobo), 0)::bigint            AS gross,
            COALESCE(SUM(l.paye_kobo), 0)::bigint             AS paye,
            COALESCE(SUM(l.employee_pension_kobo), 0)::bigint AS pension,
            COALESCE(SUM(l.nhf_kobo), 0)::bigint              AS nhf
       FROM pay_run_lines l
       JOIN pay_runs r ON r.id = l.pay_run_id
      WHERE l.organization_id = $1 AND l.employee_id = $2
        AND r.period_year = $3 AND r.period_month < $4
        AND r.status <> 'reversed'`,
    [orgId, employeeId, year, month]
  );
  const row = rows[0] || {};
  return {
    gross: int(row.gross), paye: int(row.paye), pension: int(row.pension), nhf: int(row.nhf)
  };
}

// How many more times this employee will be paid before the year ends. A
// leaver's final month is zero, which is what makes that month settle the
// year's tax.
function periodsRemaining(employee, year, month) {
  const endOfYear = 12;
  if (!employee.end_date) return endOfYear - month;
  const end = String(employee.end_date).slice(0, 10);
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  if (endYear > year) return endOfYear - month;
  if (endYear < year) return 0;
  return Math.max(0, endMonth - month);
}

// The components for one employee: stated outright, or split from gross by
// their structure, or by the 50/30/20 default.
function componentsOf(employee, structures) {
  const gross = int(employee.gross_monthly_kobo);
  if (employee.basic_kobo !== null && employee.basic_kobo !== undefined) {
    return {
      basic: int(employee.basic_kobo),
      housing: int(employee.housing_kobo),
      transport: int(employee.transport_kobo)
    };
  }
  const s = structures.get(employee.structure_id) || structures.get('default') || DEFAULT_STRUCTURE;
  return split(gross, s);
}

async function structuresFor(client, orgId) {
  const rows = (await client.query(
    'SELECT * FROM salary_structures WHERE organization_id = $1', [orgId]
  )).rows;
  const map = new Map();
  for (const r of rows) {
    const s = { basicBp: r.basic_bp, housingBp: r.housing_bp, transportBp: r.transport_bp };
    map.set(r.id, s);
    if (r.is_default) map.set('default', s);
  }
  return map;
}

const settingsFor = (client, orgId) => client.query(
  `INSERT INTO payroll_settings (organization_id) VALUES ($1)
   ON CONFLICT (organization_id) DO NOTHING`, [orgId]
).then(() => client.query('SELECT * FROM payroll_settings WHERE organization_id = $1', [orgId]))
  .then((r) => r.rows[0]);

// ------------------------------------------------------------ calculating

// Build or rebuild a draft. Safe to run repeatedly: it replaces the draft's
// lines, which is exactly what somebody reviewing a payroll and correcting a
// bonus expects to be able to do.
async function build(orgId, { year, month, payDate, userId, adjustments }) {
  const periodDate = periodDateOf(year, month);
  const rules = statutory.rulesFor(periodDate);

  return tx(async (client) => {
    const existing = await client.query(
      `SELECT * FROM pay_runs
        WHERE organization_id = $1 AND period_year = $2 AND period_month = $3
          AND status <> 'reversed'
        FOR UPDATE`,
      [orgId, year, month]
    );
    let run = existing.rows[0];

    if (run && run.status !== 'draft') {
      throw fail('The payroll for ' + labelOf(year, month) + ' has already been ' + run.status +
        '. Reverse it if it needs to change.', 409, 'PAYROLL_LOCKED');
    }

    if (!run) {
      const created = await client.query(
        `INSERT INTO pay_runs (organization_id, period_year, period_month, period_date,
                               pay_date, rule_set, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [orgId, year, month, periodDate, payDate || null, rules.id, userId || null]
      );
      run = created.rows[0];
    } else {
      await client.query(
        'UPDATE pay_runs SET pay_date = COALESCE($2, pay_date), rule_set = $3 WHERE id = $1',
        [run.id, payDate || null, rules.id]
      );
      await client.query('DELETE FROM pay_run_lines WHERE pay_run_id = $1', [run.id]);
    }

    const [people, structures, settings] = await Promise.all([
      employeesFor(client, orgId, year, month),
      structuresFor(client, orgId),
      settingsFor(client, orgId)
    ]);

    if (!people.length) {
      throw fail('There are no employees to pay for ' + labelOf(year, month) +
        '. Add staff before running payroll.', 424, 'NO_EMPLOYEES');
    }

    const byEmployee = new Map(
      (adjustments || []).map((a) => [String(a.employeeId), a])
    );

    const lines = [];
    for (const employee of people) {
      if (!employee.gross_monthly_kobo && employee.basic_kobo === null) {
        throw fail(employee.full_name + ' has no salary recorded, so the payroll cannot be ' +
          'calculated. Set a salary or remove them from this month.', 424, 'NO_SALARY');
      }

      const parts = componentsOf(employee, structures);
      const extra = byEmployee.get(String(employee.id)) || {};
      const ytd = await ytdFor(client, orgId, employee.id, year, month);

      const result = calculate({
        periodDate,
        basic: parts.basic,
        housing: parts.housing,
        transport: parts.transport,
        otherAllowances: int(employee.other_allowances_kobo) + int(extra.allowance),
        bonus: int(extra.bonus),
        commission: int(extra.commission),
        overtime: int(extra.overtime),
        otherIrregular: int(extra.otherIrregular),
        otherDeductions: int(extra.deduction),
        annualRentDeclared: int(employee.annual_rent_kobo),
        pensionExempt: employee.pension_exempt || !settings.pension_applies,
        nhfExempt: employee.nhf_exempt || !settings.nhf_applies,
        employerPensionBp: employee.employer_pension_bp || null,
        periodsRemaining: periodsRemaining(employee, year, month),
        ytd
      });

      const inserted = await client.query(
        `INSERT INTO pay_run_lines
           (organization_id, pay_run_id, employee_id, employee_name, staff_number,
            designation, department, bank_name, bank_account_name, bank_account_number,
            basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo,
            bonus_kobo, commission_kobo, overtime_kobo, other_irregular_kobo, gross_kobo,
            employee_pension_kobo, nhf_kobo, paye_kobo, other_deductions_kobo,
            total_deductions_kobo, employer_pension_kobo, net_kobo, tax_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 $20,$21,$22,$23,$24,$25,$26,$27)
         RETURNING *`,
        [orgId, run.id, employee.id, employee.full_name, employee.staff_number,
          employee.designation, employee.department, employee.bank_name,
          employee.bank_account_name, employee.bank_account_number,
          result.earnings.basic, result.earnings.housing, result.earnings.transport,
          result.earnings.otherAllowances, result.earnings.bonus, result.earnings.commission,
          result.earnings.overtime, result.earnings.otherIrregular, result.earnings.gross,
          result.deductions.employeePension, result.deductions.nhf, result.deductions.paye,
          result.deductions.other, result.deductions.total, result.employer.pension,
          result.net, JSON.stringify(result.tax)]
      );
      lines.push(inserted.rows[0]);
    }

    return { run: await reload(client, run.id), lines };
  });
}

// ------------------------------------------------------------------ totals

// Derived from the lines every time, never stored. The one number that must
// not be capable of disagreeing with the payslips it summarises.
function totalsOf(lines) {
  const sum = (key) => lines.reduce((a, l) => a + int(l[key]), 0);
  return {
    employees: lines.length,
    gross: sum('gross_kobo'),
    basic: sum('basic_kobo'),
    employeePension: sum('employee_pension_kobo'),
    employerPension: sum('employer_pension_kobo'),
    nhf: sum('nhf_kobo'),
    paye: sum('paye_kobo'),
    otherDeductions: sum('other_deductions_kobo'),
    deductions: sum('total_deductions_kobo'),
    net: sum('net_kobo'),
    employerCost: sum('gross_kobo') + sum('employer_pension_kobo')
  };
}

const LINES_SQL =
  'SELECT * FROM pay_run_lines WHERE organization_id = $1 AND pay_run_id = $2 ORDER BY employee_name';

// Takes a transaction client when there is one, because `many` reads from the
// pool and would miss rows the open transaction has not committed.
const linesOf = (orgId, runId, client) => (client
  ? client.query(LINES_SQL, [orgId, runId]).then((r) => r.rows)
  : many(LINES_SQL, [orgId, runId]));

async function reload(client, id) {
  const { rows } = await client.query('SELECT * FROM pay_runs WHERE id = $1', [id]);
  return rows[0];
}

// --------------------------------------------------------------- approving

async function approve(orgId, runId, userId) {
  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM pay_runs WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [orgId, runId]
    );
    const run = rows[0];
    if (!run) throw fail('No such payroll.', 404, 'NO_SUCH_RUN');
    if (run.status === 'approved' || run.status === 'paid') {
      // Not an error. Somebody pressed the button twice, and the honest
      // answer is that it is already done.
      return { run, alreadyApproved: true, totals: totalsOf(await linesOf(orgId, runId, client)) };
    }
    if (run.status === 'reversed') {
      throw fail('That payroll was reversed. Build a new one for the month.', 409, 'RUN_REVERSED');
    }

    const lines = (await client.query(
      'SELECT * FROM pay_run_lines WHERE pay_run_id = $1', [runId]
    )).rows;
    if (!lines.length) {
      throw fail('There is nothing in this payroll to approve.', 424, 'EMPTY_RUN');
    }

    const totals = totalsOf(lines);
    if (totals.net < 0) {
      throw fail('This payroll has a negative net total, which cannot be right. ' +
        'Check the deductions before approving.', 424, 'NEGATIVE_NET');
    }

    await accounts.ensure(client, orgId);
    const entry = await posting.payrollApproved(client, {
      orgId,
      run: Object.assign({}, run, { period_label: labelOf(run.period_year, run.period_month) }),
      totals,
      userId
    });

    const updated = await client.query(
      `UPDATE pay_runs
          SET status = 'approved', approved_by = $2, approved_at = now(), journal_entry_id = $3
        WHERE id = $1 RETURNING *`,
      [runId, userId || null, entry ? entry.id : null]
    );

    return { run: updated.rows[0], totals, entryId: entry ? entry.id : null, alreadyApproved: false };
  });
}

// Undone, not erased. A mirror journal on the date the correction is made,
// so a closed month stays closed and both figures stay visible.
async function reverseRun(orgId, runId, { userId, reason, date }) {
  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM pay_runs WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, runId]
    );
    const run = rows[0];
    if (!run) throw fail('No such payroll.', 404, 'NO_SUCH_RUN');
    if (run.status === 'draft') {
      throw fail('That payroll has not been approved, so there is nothing to reverse. ' +
        'Delete it instead.', 424, 'NOT_APPROVED');
    }
    if (run.status === 'reversed') return { run, alreadyReversed: true };

    const paid = await client.query(
      'SELECT COUNT(*)::int AS n FROM payroll_payments WHERE pay_run_id = $1', [runId]
    );
    if (paid.rows[0].n > 0) {
      throw fail('Payments have already been recorded against this payroll. Reverse those ' +
        'first, so the bank and the books do not disagree.', 409, 'HAS_PAYMENTS');
    }

    if (run.journal_entry_id) {
      await posting.reverse(client, {
        orgId,
        entryId: run.journal_entry_id,
        date: date || new Date().toISOString().slice(0, 10),
        memo: 'Reversal of payroll ' + labelOf(run.period_year, run.period_month) +
          (reason ? ' — ' + reason : ''),
        userId
      });
    }

    const updated = await client.query(
      `UPDATE pay_runs SET status = 'reversed', reversed_at = now(), reversal_reason = $2
        WHERE id = $1 RETURNING *`,
      [runId, reason || null]
    );
    return { run: updated.rows[0], alreadyReversed: false };
  });
}

// A draft can be thrown away. Anything approved cannot — that is what
// approval means.
async function discard(orgId, runId) {
  const run = await one('SELECT * FROM pay_runs WHERE organization_id = $1 AND id = $2', [orgId, runId]);
  if (!run) throw fail('No such payroll.', 404, 'NO_SUCH_RUN');
  if (run.status !== 'draft') {
    throw fail('Only a draft can be deleted. This one is ' + run.status + '.', 409, 'NOT_DRAFT');
  }
  await query('DELETE FROM pay_runs WHERE id = $1', [runId]);
  return { deleted: true };
}

// ---------------------------------------------------------------- payments

async function recordPayment(orgId, runId, { kind, amountKobo, paidOn, bankAccountId, reference, note, userId }) {
  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM pay_runs WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, runId]
    );
    const run = rows[0];
    if (!run) throw fail('No such payroll.', 404, 'NO_SUCH_RUN');
    if (run.status === 'draft') {
      throw fail('Approve the payroll before recording payments against it.', 424, 'NOT_APPROVED');
    }
    if (run.status === 'reversed') {
      throw fail('That payroll was reversed.', 409, 'RUN_REVERSED');
    }

    const amount = int(amountKobo);
    if (amount <= 0) throw fail('A payment has to be more than nothing.', 422, 'BAD_AMOUNT');

    const lines = (await client.query('SELECT * FROM pay_run_lines WHERE pay_run_id = $1', [runId])).rows;
    const totals = totalsOf(lines);
    const owed = { salaries: totals.net, paye: totals.paye,
      pension: totals.employeePension + totals.employerPension, nhf: totals.nhf, other: Infinity };

    const already = await client.query(
      'SELECT COALESCE(SUM(amount_kobo), 0)::bigint AS n FROM payroll_payments WHERE pay_run_id = $1 AND kind = $2',
      [runId, kind]
    );
    const paidSoFar = int(already.rows[0].n);
    if (owed[kind] !== Infinity && paidSoFar + amount > owed[kind]) {
      throw fail('That is more than this payroll owes for ' + kind + '. Owed ' +
        ((owed[kind] - paidSoFar) / 100).toFixed(2) + ', tried to pay ' +
        (amount / 100).toFixed(2) + '.', 422, 'OVERPAYMENT');
    }

    const created = await client.query(
      `INSERT INTO payroll_payments
         (organization_id, pay_run_id, kind, amount_kobo, paid_on, bank_account_id,
          reference, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [orgId, runId, kind, amount, paidOn, bankAccountId || null, reference || null,
        note || null, userId || null]
    );
    const payment = created.rows[0];

    let entry = null;
    if (kind !== 'other') {
      await accounts.ensure(client, orgId);
      entry = await posting.payrollPaid(client, {
        orgId,
        run: Object.assign({}, run, { period_label: labelOf(run.period_year, run.period_month) }),
        payment,
        bankAccountId,
        userId
      });
      await client.query('UPDATE payroll_payments SET journal_entry_id = $2 WHERE id = $1',
        [payment.id, entry ? entry.id : null]);
    }

    // Fully settled on every front, and the run says so.
    const after = await client.query(
      `SELECT kind, COALESCE(SUM(amount_kobo), 0)::bigint AS n
         FROM payroll_payments WHERE pay_run_id = $1 GROUP BY kind`, [runId]
    );
    const settled = new Map(after.rows.map((r) => [r.kind, int(r.n)]));
    const fully = ['salaries', 'paye', 'pension', 'nhf'].every(
      (k) => owed[k] === 0 || (settled.get(k) || 0) >= owed[k]
    );
    if (fully && run.status === 'approved') {
      await client.query("UPDATE pay_runs SET status = 'paid' WHERE id = $1", [runId]);
    }

    return { payment, entryId: entry ? entry.id : null };
  });
}

// ------------------------------------------------------------------ reading

async function detail(orgId, runId) {
  const run = await one('SELECT * FROM pay_runs WHERE organization_id = $1 AND id = $2', [orgId, runId]);
  if (!run) return null;
  const lines = await linesOf(orgId, runId);
  const payments = await many(
    'SELECT * FROM payroll_payments WHERE pay_run_id = $1 ORDER BY paid_on, created_at', [runId]
  );
  const rules = statutory.ruleSetById(run.rule_set) || statutory.rulesFor(run.period_date);
  return {
    run,
    lines,
    payments,
    totals: totalsOf(lines),
    label: labelOf(run.period_year, run.period_month),
    rules: { id: rules.id, label: rules.label, note: rules.note, doubts: statutory.doubts(rules) }
  };
}

module.exports = {
  build, approve, reverseRun, discard, recordPayment, detail,
  totalsOf, linesOf, employeesFor, periodsRemaining, componentsOf,
  periodDateOf, labelOf, lastDayOf, fail
};
