// Payslips, as A4 PDFs.
//
// Built on the same @react-pdf setup the invoices use — the same registered
// fonts, the same theme, the same logo from the same column — because a
// business's payslip and its invoice should look like they came from the
// same company, and because a second renderer would be a second place for
// the naira sign to break.
//
// A payslip is drawn entirely from a `pay_run_lines` row. Nothing is
// recalculated here and nothing is joined to the employee's current record:
// the row is the snapshot taken when the run was calculated, so a payslip
// reprinted in December says exactly what it said in March, even if the
// employee has since had a raise, changed bank or left.

const React = require('react');
const {
  Document, Page, Text, View, StyleSheet, Image, renderToBuffer
} = require('@react-pdf/renderer');

const money = require('../money');
const { theme } = require('../invoicing/themes');
const { registerFonts, logoSource } = require('../invoicing/pdf');

const e = React.createElement;

const naira = (kobo) => '₦' + money.format(Math.round(Number(kobo) || 0));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const periodName = (year, month) => (MONTHS[month - 1] || '') + ' ' + year;

const styles = (t) => StyleSheet.create({
  page: {
    paddingTop: 40, paddingBottom: 56, paddingHorizontal: 44,
    fontSize: 9.5, fontFamily: 'Profitna', color: t.ink
    // No lineHeight on the Page: it stops a `fixed` footer being drawn at
    // all. The invoice renderer learned this the hard way and the comment is
    // repeated here so nobody re-learns it.
  },
  logo: { width: 100, maxHeight: 44, objectFit: 'contain', marginBottom: 8 },
  row: { flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  heading: { fontSize: 17, fontWeight: 'bold', letterSpacing: t.headingSpacing },
  org: { fontSize: 12, fontWeight: 'bold' },
  label: { color: t.faint, fontSize: 7.5, letterSpacing: 1.1, textTransform: 'uppercase', marginBottom: 3 },
  muted: { color: t.muted, lineHeight: 1.4 },
  faint: { color: t.faint, fontSize: 8 },
  rule: { borderBottomWidth: 1.2, borderBottomColor: t.accent, paddingBottom: 14, marginBottom: 18 },

  grid: { flexDirection: 'row', marginBottom: 18 },
  cell: { flex: 1, paddingRight: 14 },

  columns: { flexDirection: 'row', marginBottom: 4 },
  column: { flex: 1 },
  columnGap: { width: 18 },

  sectionHead: {
    backgroundColor: t.band, paddingVertical: 6, paddingHorizontal: 9,
    fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 'bold'
  },
  line: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 4.5, paddingHorizontal: 9,
    borderBottomWidth: 0.5, borderBottomColor: t.rule
  },
  lineLabel: { flex: 1, paddingRight: 8 },
  amount: { textAlign: 'right' },
  subtotal: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 6, paddingHorizontal: 9, fontWeight: 'bold',
    borderTopWidth: 1, borderTopColor: t.ink
  },

  net: {
    marginTop: 16, backgroundColor: t.accent, paddingVertical: 12, paddingHorizontal: 14,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'
  },
  netLabel: { color: t.accentText, fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase' },
  netValue: { color: t.accentText, fontSize: 15, fontWeight: 'bold' },

  noteBox: { marginTop: 16, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: t.rule },
  footer: {
    position: 'absolute', bottom: 26, left: 44, right: 44,
    flexDirection: 'row', justifyContent: 'space-between'
  }
});

// A row of label-over-value cells.
const facts = (s, items) => e(View, { style: s.grid },
  ...items.filter(Boolean).map(([label, value], i) =>
    e(View, { style: s.cell, key: 'f' + i },
      e(Text, { style: s.label }, label),
      e(Text, null, value || '—'))));

const moneyLine = (s, label, kobo, key) => e(View, { style: s.line, key },
  e(Text, { style: s.lineLabel }, label),
  e(Text, { style: s.amount }, naira(kobo)));

function earningsBlock(s, line) {
  const rows = [
    ['Basic salary', line.basic_kobo],
    ['Housing allowance', line.housing_kobo],
    ['Transport allowance', line.transport_kobo],
    ['Other allowances', line.other_allowances_kobo],
    ['Bonus', line.bonus_kobo],
    ['Commission', line.commission_kobo],
    ['Overtime', line.overtime_kobo],
    ['Other', line.other_irregular_kobo]
  ].filter(([, v]) => Number(v) > 0);

  return e(View, { style: s.column },
    e(Text, { style: s.sectionHead }, 'Earnings'),
    ...rows.map(([l, v], i) => moneyLine(s, l, v, 'e' + i)),
    e(View, { style: s.subtotal },
      e(Text, null, 'Gross pay'),
      e(Text, { style: s.amount }, naira(line.gross_kobo))));
}

function deductionsBlock(s, line) {
  const rows = [
    ['Pension (employee)', line.employee_pension_kobo],
    ['National Housing Fund', line.nhf_kobo],
    ['PAYE', line.paye_kobo],
    ['Other deductions', line.other_deductions_kobo]
  ].filter(([, v]) => Number(v) > 0);

  return e(View, { style: s.column },
    e(Text, { style: s.sectionHead }, 'Deductions'),
    rows.length
      ? null
      : e(View, { style: s.line },
        e(Text, { style: s.lineLabel }, 'None'),
        e(Text, { style: s.amount }, naira(0))),
    ...rows.map(([l, v], i) => moneyLine(s, l, v, 'd' + i)),
    e(View, { style: s.subtotal },
      e(Text, null, 'Total deductions'),
      e(Text, { style: s.amount }, naira(line.total_deductions_kobo))));
}

function payslipPage(s, t, { org, run, line, settings }) {
  const src = logoSource(org);
  const period = periodName(run.period_year, run.period_month);

  return e(Page, { size: 'A4', style: s.page, wrap: true, key: line.id },
    // ---------------------------------------------------------------- head
    e(View, { style: s.rule },
      e(View, { style: s.between },
        e(View, null,
          src ? e(Image, { style: s.logo, src }) : null,
          e(Text, { style: s.org }, org.name || ''),
          org.state ? e(Text, { style: s.faint }, org.state) : null),
        e(View, { style: { alignItems: 'flex-end' } },
          e(Text, { style: s.heading }, 'PAYSLIP'),
          e(Text, { style: s.muted }, period)))),

    // --------------------------------------------------------------- who
    facts(s, [
      ['Employee', line.employee_name],
      line.staff_number ? ['Staff number', line.staff_number] : null,
      line.designation ? ['Designation', line.designation] : null,
      line.department ? ['Department', line.department] : null
    ]),
    facts(s, [
      ['Bank', line.bank_name],
      ['Account name', line.bank_account_name],
      ['Account number', line.bank_account_number],
      run.pay_date ? ['Pay date', run.pay_date] : null
    ]),

    // ------------------------------------------------------ the two sides
    e(View, { style: s.columns },
      earningsBlock(s, line),
      e(View, { style: s.columnGap }),
      deductionsBlock(s, line)),

    // ------------------------------------------------------------- net pay
    e(View, { style: s.net },
      e(Text, { style: s.netLabel }, 'Net pay'),
      e(Text, { style: s.netValue }, naira(line.net_kobo))),

    // The employer's own contribution. Shown because an employee is entitled
    // to know what is being paid into their RSA on their behalf, and placed
    // well away from the deductions so it can never be mistaken for one.
    Number(line.employer_pension_kobo) > 0
      ? e(View, { style: s.noteBox },
        e(Text, { style: s.label }, 'Paid by your employer, not deducted from your pay'),
        e(View, { style: s.between },
          e(Text, { style: s.muted }, 'Employer pension contribution'),
          e(Text, null, naira(line.employer_pension_kobo))))
      : null,

    settings && settings.payslip_note
      ? e(View, { style: s.noteBox },
        e(Text, { style: s.label }, 'Note'),
        e(Text, { style: s.muted }, settings.payslip_note))
      : null,

    // ------------------------------------------------------------- footer
    e(View, { style: s.footer, fixed: true },
      e(Text, { style: s.faint },
        'This payslip is computer generated. ' + (run.rule_set === 'NG-2026-NTA'
          ? 'PAYE under the Nigeria Tax Act 2025.'
          : 'PAYE under the rules in force for this period.')),
      e(Text, {
        style: s.faint,
        render: ({ pageNumber, totalPages }) => 'Page ' + pageNumber + ' of ' + totalPages
      })));
}

// One document, any number of payslips. Bulk is the same call with more
// lines, so the single and the batch cannot drift apart.
function payslipDocument({ org, run, lines, settings, themeName }) {
  registerFonts();
  const t = theme(themeName || undefined);
  const s = styles(t);
  return e(Document, {
    title: 'Payslip ' + periodName(run.period_year, run.period_month),
    author: (org && org.name) || 'Profitna'
  }, ...lines.map((line) => payslipPage(s, t, { org, run, line, settings })));
}

const render = (data) => renderToBuffer(payslipDocument(data));

module.exports = { render, payslipDocument, periodName, naira };
