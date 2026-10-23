// Nigerian payroll statute, as dated rule sets.
//
// The one thing this file exists to prevent: a payroll re-opened in December
// being recalculated with December's law. A payslip is a statement about what
// was owed under the rules in force in the month it covers, and a correction
// to a later rule must not silently restate an earlier month. So the rules
// are a list of versions with effective dates, `rulesFor(date)` picks the one
// that was in force, and nothing anywhere else in the payroll module knows a
// tax rate.
//
// It is also why the rules live here rather than in a table an administrator
// can edit. A business that could change its own tax bands could change them
// retrospectively, and then no payslip it ever issued could be relied upon.
// What a business *can* configure — whether NSITF applies to it, what it pays
// above the pension minimum — is genuinely its own and lives in its settings.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED ON 1 JANUARY 2026, AND WHAT IS STILL UNCONFIRMED
//
// The Nigeria Tax Act 2025 took effect on 1 January 2026 and rewrote personal
// income tax. The Consolidated Relief Allowance is gone. The bands are new.
// The first ₦800,000 of chargeable income is taxed at nothing.
//
// Three values in the 2026 set are marked `confirmed: false`. They are the
// ones the published guidance disagreed about when this was written, and the
// disagreement is recorded here rather than resolved by picking the reading
// that produces the nicest number:
//
//   rentReliefCap     — SETTLED 16 October 2026 at ₦500,000, by the operator
//                       of this deployment rather than by a citation. One
//                       source had said ₦200,000.
//   individualMinimumTax — whether the old 1%-of-gross floor survives. No
//                       source consulted said either way, so it is off: a
//                       floor nobody can point to in the Act should not be
//                       deducted from somebody's wages.
//   nsitfBase         — 1% of payroll or of gross emolument; sources split.
//
// Every one of them is surfaced in the product rather than buried. When the
// Act's text settles them, the fix is a new dated rule set — never an edit to
// an old one, because an old one is what somebody's March payslip was built
// from.
// ---------------------------------------------------------------------------

const { roundHalfUp } = require('../money');

const NAIRA = (n) => n * 100;        // written in naira, stored in kobo
const PCT = (n) => Math.round(n * 100); // 15% -> 1500 basis points

// ---------------------------------------------------------------- the sets

// Bands are cumulative and expressed as a width rather than a ceiling, so the
// arithmetic below cannot disagree with the table: each band taxes at most
// `width` kobo of whatever is left.
const NTA_2026_BANDS = Object.freeze([
  { width: NAIRA(800000), rateBp: PCT(0) },
  { width: NAIRA(2200000), rateBp: PCT(15) },
  { width: NAIRA(9000000), rateBp: PCT(18) },
  { width: NAIRA(13000000), rateBp: PCT(21) },
  { width: NAIRA(25000000), rateBp: PCT(23) },
  { width: Infinity, rateBp: PCT(25) }
]);

// The regime before the Nigeria Tax Act 2025. Kept because a business
// correcting a 2025 payroll in 2026 must get 2025's answer, and because the
// uploaded spreadsheet this module replaces was built on it — the test suite
// reproduces its figures to prove the two regimes are both implemented and
// genuinely different.
const PITA_BANDS = Object.freeze([
  { width: NAIRA(300000), rateBp: PCT(7) },
  { width: NAIRA(300000), rateBp: PCT(11) },
  { width: NAIRA(500000), rateBp: PCT(15) },
  { width: NAIRA(500000), rateBp: PCT(19) },
  { width: NAIRA(1600000), rateBp: PCT(21) },
  { width: Infinity, rateBp: PCT(24) }
]);

const RULE_SETS = Object.freeze([
  Object.freeze({
    id: 'NG-2026-NTA',
    label: 'Nigeria Tax Act 2025',
    effectiveFrom: '2026-01-01',
    note: 'In force from 1 January 2026. The Consolidated Relief Allowance is abolished ' +
      'and replaced by rent relief; the first ₦800,000 of chargeable income is not taxed.',
    bands: NTA_2026_BANDS,

    // Gone, and named so that a reader looking for it finds out why rather
    // than assuming an omission.
    consolidatedRelief: Object.freeze({ applies: false, abolishedBy: 'Nigeria Tax Act 2025' }),

    // 20% of rent actually paid, capped. Only for an employee who declares a
    // rent — it is a relief claimed, not an allowance given, so an employee
    // who declares nothing gets nothing rather than a default.
    rentRelief: Object.freeze({
      rateBp: PCT(20),
      cap: NAIRA(500000),
      requiresDeclaration: true,
      // Settled on 16 October 2026 by the operator of this deployment, against
      // the majority of published guidance; one outlying source had said
      // ₦200,000. The value here never changed — what changed is that it is
      // no longer flagged on screen as resting on a reading.
      //
      // Recorded as an operator decision rather than as a citation of the
      // Act, because that is what it is. If it is ever disputed, this line
      // says exactly how much weight it carries.
      confirmed: true,
      confirmedOn: '2026-10-16',
      confirmedBy: 'operator'
    }),

    // Nobody earning the national minimum wage pays PAYE.
    minimumWageExemption: Object.freeze({ monthly: NAIRA(70000) }),

    individualMinimumTax: Object.freeze({
      applies: false,
      confirmed: false,
      doubt: 'The old 1%-of-gross floor is not clearly carried into the Act, and no source ' +
        'consulted confirmed it either way. It is off: a deduction nobody can point to ' +
        'should not come out of wages.'
    }),

    // Pension Reform Act 2014. The base is basic, housing and transport — not
    // gross — which is the single most common payroll error in Nigeria.
    pension: Object.freeze({
      employeeBp: PCT(8),
      employerBp: PCT(10),
      base: 'bht',
      minimumEmployees: 3
    }),

    // Employee side, 2.5% of basic.
    nhf: Object.freeze({ employeeBp: PCT(2.5), base: 'basic' }),

    // Employer-only, and off until a business says it applies to it. Neither
    // is deducted from anybody's wages; both are employer cost.
    nsitf: Object.freeze({
      employerBp: PCT(1),
      base: 'gross',
      confirmed: false,
      doubt: 'Sources differ on whether the 1% is of gross emolument or of total payroll.'
    }),
    itf: Object.freeze({
      employerBp: PCT(1),
      base: 'gross',
      cadence: 'annual',
      appliesFrom: Object.freeze({ employees: 5, turnover: NAIRA(50000000) })
    })
  }),

  Object.freeze({
    id: 'NG-PITA',
    label: 'Personal Income Tax Act (pre-2026)',
    effectiveFrom: '2011-06-14',
    note: 'The regime in force until 31 December 2025. Kept so that a correction to an ' +
      'earlier year is calculated under the law of that year.',
    bands: PITA_BANDS,
    consolidatedRelief: Object.freeze({
      applies: true,
      // Higher of ₦200,000 or 1% of gross, PLUS 20% of gross — annually, which
      // is the detail the spreadsheet this replaces got wrong by applying the
      // ₦200,000 every month.
      floor: NAIRA(200000),
      floorRateBp: PCT(1),
      rateBp: PCT(20)
    }),
    rentRelief: Object.freeze({ rateBp: 0, cap: 0, requiresDeclaration: true }),
    minimumWageExemption: Object.freeze({ monthly: 0 }),
    individualMinimumTax: Object.freeze({ applies: true, rateBp: PCT(1), base: 'gross' }),
    pension: Object.freeze({ employeeBp: PCT(8), employerBp: PCT(10), base: 'bht', minimumEmployees: 3 }),
    nhf: Object.freeze({ employeeBp: PCT(2.5), base: 'basic' }),
    nsitf: Object.freeze({ employerBp: PCT(1), base: 'gross' }),
    itf: Object.freeze({ employerBp: PCT(1), base: 'gross', cadence: 'annual' })
  })
]);

// Newest first, so the first match is the one in force.
const ORDERED = Object.freeze(
  RULE_SETS.slice().sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
);

// The rules in force on a date. Dates are ISO strings throughout this
// codebase and compared as strings, which is correct for ISO and avoids the
// timezone question entirely.
function rulesFor(date) {
  const on = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw new Error('payroll: a pay period needs a date, got ' + JSON.stringify(date));
  }
  const found = ORDERED.find((r) => r.effectiveFrom <= on);
  if (!found) throw new Error('payroll: no tax rules are recorded for ' + on);
  return found;
}

const ruleSetById = (id) => RULE_SETS.find((r) => r.id === id) || null;

// Everything in a rule set that is not yet settled, for the screen that has
// to say so. An empty list means the set is fully confirmed.
function doubts(rules) {
  const out = [];
  for (const key of ['rentRelief', 'individualMinimumTax', 'nsitf']) {
    const part = rules[key];
    if (part && part.confirmed === false) out.push({ item: key, doubt: part.doubt });
  }
  return out;
}

// ------------------------------------------------------------ the arithmetic

// Tax on an annual chargeable income, by the bands in force.
//
// Returns the total and the working, because "why is my tax that" is the
// question every payroll system is asked and most cannot answer.
function taxOn(chargeableKobo, rules) {
  const chargeable = Math.max(0, Math.round(chargeableKobo));
  let left = chargeable;
  let total = 0;
  const workings = [];

  for (const band of rules.bands) {
    if (left <= 0) break;
    const taxedHere = band.width === Infinity ? left : Math.min(left, band.width);
    const tax = roundHalfUp(taxedHere * band.rateBp, 10000);
    if (taxedHere > 0) {
      workings.push({ amount: taxedHere, rateBp: band.rateBp, tax });
      total += tax;
    }
    left -= taxedHere;
  }

  return { tax: total, chargeable, workings };
}

// The relief for rent actually paid and declared. Nothing declared, nothing
// given — it is a relief, not an allowance.
function rentRelief(annualRentKobo, rules) {
  const r = rules.rentRelief;
  if (!r || !r.rateBp) return 0;
  const rent = Math.max(0, Math.round(annualRentKobo || 0));
  if (!rent) return 0;
  return Math.min(roundHalfUp(rent * r.rateBp, 10000), r.cap);
}

// The old CRA, for a pre-2026 period. Annual, which is the whole point.
function consolidatedRelief(annualGrossKobo, rules) {
  const c = rules.consolidatedRelief;
  if (!c || !c.applies) return 0;
  const gross = Math.max(0, Math.round(annualGrossKobo || 0));
  const onePercent = roundHalfUp(gross * c.floorRateBp, 10000);
  return Math.max(c.floor, onePercent) + roundHalfUp(gross * c.rateBp, 10000);
}

const pensionBase = (parts) => Math.max(0, (parts.basic || 0) + (parts.housing || 0) + (parts.transport || 0));

const employeePension = (parts, rules) => roundHalfUp(pensionBase(parts) * rules.pension.employeeBp, 10000);
const employerPension = (parts, rules, employerBpOverride) =>
  roundHalfUp(pensionBase(parts) * (employerBpOverride || rules.pension.employerBp), 10000);

const nhf = (parts, rules) => roundHalfUp(Math.max(0, parts.basic || 0) * rules.nhf.employeeBp, 10000);

module.exports = {
  RULE_SETS, ORDERED, rulesFor, ruleSetById, doubts,
  taxOn, rentRelief, consolidatedRelief,
  pensionBase, employeePension, employerPension, nhf,
  NAIRA, PCT
};
