// One employee, one month: gross to net.
//
// Pure. It takes numbers and returns numbers, touches no database and reads
// no clock, which is what makes it testable against figures worked by hand —
// and a payroll engine nobody can check by hand is a payroll engine nobody
// should trust.
//
// ---------------------------------------------------------------------------
// WHY THE TAX IS CALCULATED ANNUALLY AND THEN SPREAD
//
// Nigerian PAYE is a tax on annual income. The bands are annual, the reliefs
// are annual, and the ₦800,000 that is not taxed is ₦800,000 a year. Dividing
// those by twelve and applying them monthly is the error in almost every
// spreadsheet that does this — including the one this module replaces, which
// granted a ₦200,000 annual relief every month and so under-deducted by more
// than three times for an ordinary salary.
//
// So: project the year, tax the year, then charge the share of that year's
// tax the employee has actually earned so far, less what has already been
// taken. The share is by income rather than by elapsed months, which is what
// makes a bonus month self-correct: the bonus raises both the projected
// annual income and the share earned to date, and the extra tax lands in the
// month the bonus was paid rather than being smeared over the rest of the
// year.
//
// It also handles the two cases a naive monthly calculation gets wrong:
//
//   A joiner in September is taxed on what they will actually earn this year,
//   so they get the full benefit of the nil band rather than a twelfth of it.
//
//   A leaver's final month settles the year: their share earned to date
//   becomes the whole of it, so any under-deduction is collected and any
//   over-deduction is refunded.
// ---------------------------------------------------------------------------

const { roundHalfUp } = require('../money');
const statutory = require('./statutory');

const PERIODS = 12;

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const positive = (v) => Math.max(0, int(v));

// The 50 / 30 / 20 template, offered because it is what most Nigerian SMEs
// use and because the pension base depends on the split — but never imposed.
// A business that sets its own components gets its own components.
const DEFAULT_STRUCTURE = Object.freeze({
  basicBp: 5000, housingBp: 3000, transportBp: 2000
});

// Split a gross figure into components by basis points. The last component
// takes the remainder, so the parts always add back to the whole and a
// rounding kobo cannot go missing.
function split(grossKobo, structure) {
  const gross = positive(grossKobo);
  const s = structure || DEFAULT_STRUCTURE;
  const basic = roundHalfUp(gross * (s.basicBp || 0), 10000);
  const housing = roundHalfUp(gross * (s.housingBp || 0), 10000);
  const transport = gross - basic - housing;
  return { basic, housing, transport: Math.max(0, transport) };
}

// What an employee is paid this month, separated into the part that recurs
// and the part that does not. The distinction matters: only the recurring
// part can be projected across the rest of the year.
function earnings(input) {
  const recurring = positive(input.basic) + positive(input.housing) + positive(input.transport) +
    positive(input.otherAllowances);
  const irregular = positive(input.bonus) + positive(input.commission) + positive(input.overtime) +
    positive(input.otherIrregular);
  return { recurring, irregular, gross: recurring + irregular };
}

// ---------------------------------------------------------------------------

// `input` is one employee for one period:
//
//   periodDate        'YYYY-MM-01' — decides which rules apply
//   basic/housing/transport/otherAllowances   recurring, kobo
//   bonus/commission/overtime/otherIrregular  this period only, kobo
//   annualRentDeclared                        kobo, for rent relief
//   pensionExempt / nhfExempt                 booleans
//   employerPensionBp                         if the employer pays above 10%
//   voluntaryPension, otherDeductions         kobo
//   periodsRemaining  how many more times this employee will be paid this
//                     year after this one. 0 for a leaver's final month.
//   ytd               { gross, paye, pension, nhf } before this period
//
// Returns every figure a payslip needs, plus the working behind the tax.
function calculate(input) {
  const rules = statutory.rulesFor(input.periodDate);
  const parts = {
    basic: positive(input.basic),
    housing: positive(input.housing),
    transport: positive(input.transport)
  };
  const pay = earnings(input);

  const ytd = {
    gross: positive(input.ytd && input.ytd.gross),
    paye: positive(input.ytd && input.ytd.paye),
    pension: positive(input.ytd && input.ytd.pension),
    nhf: positive(input.ytd && input.ytd.nhf)
  };

  // -------------------------------------------------- contributions, monthly
  const pensionable = !input.pensionExempt;
  const employeePension = pensionable
    ? statutory.employeePension(parts, rules) + positive(input.voluntaryPension)
    : positive(input.voluntaryPension);
  const employerPension = pensionable
    ? statutory.employerPension(parts, rules, input.employerPensionBp)
    : 0;
  const nhfDue = input.nhfExempt ? 0 : statutory.nhf(parts, rules);

  // ------------------------------------------------------- project the year
  //
  // What this employee will have earned by 31 December if nothing changes:
  // everything already paid, this month, and the recurring part for each
  // month still to come. Irregular pay is never projected — a bonus in March
  // is not a promise of a bonus in April.
  const remaining = Math.max(0, int(input.periodsRemaining));
  const earnedToDate = ytd.gross + pay.gross;
  const projectedAnnualGross = earnedToDate + pay.recurring * remaining;

  const monthsOfContribution = remaining + 1;
  const projectedPension = ytd.pension + employeePension * monthsOfContribution;
  const projectedNhf = ytd.nhf + nhfDue * monthsOfContribution;

  const relief = {
    rent: statutory.rentRelief(input.annualRentDeclared, rules),
    consolidated: statutory.consolidatedRelief(projectedAnnualGross, rules),
    pension: projectedPension,
    nhf: projectedNhf
  };
  const totalRelief = relief.rent + relief.consolidated + relief.pension + relief.nhf;

  const chargeable = Math.max(0, projectedAnnualGross - totalRelief);
  const assessed = statutory.taxOn(chargeable, rules);
  let annualTax = assessed.tax;

  // The floor, where a regime has one. Applied to the projected year, not to
  // the month, for the same reason as everything else here.
  if (rules.individualMinimumTax && rules.individualMinimumTax.applies) {
    annualTax = Math.max(annualTax, roundHalfUp(projectedAnnualGross * rules.individualMinimumTax.rateBp, 10000));
  }

  // Nobody on the national minimum wage pays PAYE. Tested against the month's
  // recurring pay rather than a month containing a bonus, so a one-off
  // payment does not make somebody taxable for the year.
  const exemptByMinimumWage = Boolean(
    rules.minimumWageExemption &&
    rules.minimumWageExemption.monthly &&
    pay.recurring <= rules.minimumWageExemption.monthly
  );
  if (exemptByMinimumWage) annualTax = 0;

  // ----------------------------------------------- this period's share of it
  //
  // By income earned rather than months elapsed, so a bonus is taxed in the
  // month it is paid. Guarded: a projected year of nothing cannot be divided.
  const share = projectedAnnualGross > 0
    ? roundHalfUp(annualTax * earnedToDate, projectedAnnualGross)
    : 0;

  // Never negative. An over-deduction corrected mid-year reduces later months
  // to zero rather than paying tax back through the payroll, which is not
  // something an employer may do on the Revenue's behalf.
  const paye = Math.max(0, share - ytd.paye);

  const deductions = employeePension + nhfDue + paye + positive(input.otherDeductions);
  const net = pay.gross - deductions;

  return {
    ruleSet: rules.id,
    ruleLabel: rules.label,
    periodDate: String(input.periodDate).slice(0, 10),

    earnings: {
      basic: parts.basic,
      housing: parts.housing,
      transport: parts.transport,
      otherAllowances: positive(input.otherAllowances),
      bonus: positive(input.bonus),
      commission: positive(input.commission),
      overtime: positive(input.overtime),
      otherIrregular: positive(input.otherIrregular),
      recurring: pay.recurring,
      irregular: pay.irregular,
      gross: pay.gross
    },

    deductions: {
      employeePension,
      nhf: nhfDue,
      paye,
      other: positive(input.otherDeductions),
      total: deductions
    },

    // Never netted against anything the employee is paid. An employer's
    // pension contribution is the employer's cost and showing it as a
    // deduction is how a business ends up paying it twice.
    employer: {
      pension: employerPension,
      // The real cost of this person this month.
      totalCost: pay.gross + employerPension
    },

    net,

    tax: {
      projectedAnnualGross,
      relief,
      totalRelief,
      chargeable,
      annualTax,
      exemptByMinimumWage,
      // What the employee should have paid by now, and what they had.
      dueToDate: share,
      alreadyPaid: ytd.paye,
      workings: assessed.workings
    },

    ytdAfter: {
      gross: earnedToDate,
      paye: ytd.paye + paye,
      pension: ytd.pension + employeePension,
      nhf: ytd.nhf + nhfDue
    }
  };
}

module.exports = { calculate, split, earnings, DEFAULT_STRUCTURE, PERIODS };
