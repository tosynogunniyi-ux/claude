// The bank payment schedule.
//
// What a business actually hands its bank — or uploads to it — to pay a
// month's salaries: who, which bank, which account, how much. It is the most
// mundane artefact in payroll and the one most likely to be looked at by
// somebody who has never opened Profitna, so it is plain and it carries the
// totals a bank clerk will check against.
//
// Three formats, one source. CSV because every bank portal accepts it,
// Excel because that is what gets emailed, PDF because that is what gets
// signed. They are generated from the same rows in the same order, so the
// signed copy and the uploaded copy cannot disagree.

const React = require('react');
const { Document, Page, Text, View, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');

const money = require('../money');
const { theme } = require('../invoicing/themes');
const { registerFonts } = require('../invoicing/pdf');
const { periodName } = require('./payslip');

const e = React.createElement;

// The rows, in one shape, from a run's lines. Anyone with nothing to be paid
// is left out: a bank file with a zero row is a bank file that gets rejected.
function rows(lines) {
  return lines
    .filter((l) => Number(l.net_kobo) > 0)
    .map((l, i) => ({
      sn: i + 1,
      name: l.employee_name || '',
      staffNumber: l.staff_number || '',
      bank: l.bank_name || '',
      accountName: l.bank_account_name || l.employee_name || '',
      accountNumber: l.bank_account_number || '',
      netKobo: Math.round(Number(l.net_kobo) || 0)
    }));
}

// Anything that would stop a bank processing the file. Reported rather than
// silently dropped — a missing account number is the difference between
// sixteen people being paid and seventeen.
function problems(lines) {
  const out = [];
  for (const l of lines) {
    if (Number(l.net_kobo) <= 0) continue;
    if (!l.bank_account_number) out.push({ name: l.employee_name, problem: 'no account number' });
    else if (!/^\d{10}$/.test(String(l.bank_account_number).trim())) {
      // NUBAN is ten digits. Anything else will be rejected by the bank, and
      // finding that out at the counter is worse than finding it out here.
      out.push({ name: l.employee_name, problem: 'account number is not 10 digits' });
    }
    if (!l.bank_name) out.push({ name: l.employee_name, problem: 'no bank' });
  }
  return out;
}

const total = (list) => list.reduce((a, r) => a + r.netKobo, 0);

// ------------------------------------------------------------------- CSV

// Quoted where it matters, and the account number is quoted always: an
// account number beginning 0 loses its leading zero the moment a spreadsheet
// decides it is a number, and every Nigerian account that starts 0 would be
// wrong by one digit.
const quote = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';

function csv(lines) {
  const list = rows(lines);
  const head = ['S/N', 'Employee Name', 'Staff Number', 'Bank', 'Account Name', 'Account Number', 'Net Pay'];
  const body = list.map((r) => [
    r.sn, quote(r.name), quote(r.staffNumber), quote(r.bank), quote(r.accountName),
    quote(r.accountNumber), (r.netKobo / 100).toFixed(2)
  ].join(','));
  const foot = ['', quote('Total'), '', '', '', '', (total(list) / 100).toFixed(2)].join(',');
  return [head.map(quote).join(','), ...body, foot].join('\r\n') + '\r\n';
}

// ----------------------------------------------------------------- Excel
//
// Written as SpreadsheetML rather than through a library: the server has no
// xlsx dependency and adding one to emit a six-column table would be a poor
// trade. Excel, LibreOffice and Google Sheets all open this, and the account
// number is declared as text so the leading zero survives.
function xmlEscape(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function excel(lines, { org, run } = {}) {
  const list = rows(lines);
  const title = 'Salary Schedule' + (run ? ' ' + periodName(run.period_year, run.period_month) : '');

  const cell = (v, type) => '<Cell><Data ss:Type="' + type + '">' + xmlEscape(v) + '</Data></Cell>';
  const textRow = (cells) => '<Row>' + cells.join('') + '</Row>';

  const body = list.map((r) => textRow([
    cell(r.sn, 'Number'),
    cell(r.name, 'String'),
    cell(r.staffNumber, 'String'),
    cell(r.bank, 'String'),
    cell(r.accountName, 'String'),
    // String, deliberately. See the note above about leading zeros.
    cell(r.accountNumber, 'String'),
    cell((r.netKobo / 100).toFixed(2), 'Number')
  ])).join('');

  return '<?xml version="1.0"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>\n' +
    '<Worksheet ss:Name="Payment Schedule"><Table>' +
    (org ? textRow([cell(org.name || '', 'String')]) : '') +
    textRow([cell(title, 'String')]) +
    textRow([]) +
    '<Row>' + ['S/N', 'Employee Name', 'Staff Number', 'Bank', 'Account Name', 'Account Number', 'Net Pay']
      .map((h) => '<Cell ss:StyleID="h"><Data ss:Type="String">' + xmlEscape(h) + '</Data></Cell>').join('') +
    '</Row>' +
    body +
    textRow([cell('', 'String'), cell('Total', 'String'), cell('', 'String'), cell('', 'String'),
      cell('', 'String'), cell('', 'String'), cell((total(list) / 100).toFixed(2), 'Number')]) +
    '</Table></Worksheet></Workbook>\n';
}

// ------------------------------------------------------------------- PDF

const naira = (kobo) => '₦' + money.format(Math.round(Number(kobo) || 0));

const pdfStyles = (t) => StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 36, fontSize: 9, fontFamily: 'Profitna', color: t.ink },
  heading: { fontSize: 16, fontWeight: 'bold', letterSpacing: t.headingSpacing },
  org: { fontSize: 11, fontWeight: 'bold' },
  muted: { color: t.muted, lineHeight: 1.4 },
  faint: { color: t.faint, fontSize: 8 },
  rule: { borderBottomWidth: 1.2, borderBottomColor: t.accent, paddingBottom: 12, marginBottom: 16 },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  thead: { flexDirection: 'row', backgroundColor: t.band, paddingVertical: 6, paddingHorizontal: 6, fontWeight: 'bold', fontSize: 8 },
  tr: { flexDirection: 'row', paddingVertical: 4.5, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: t.rule },
  sn: { width: 26 },
  name: { flex: 2.2, paddingRight: 6 },
  bank: { flex: 1.3, paddingRight: 6 },
  acct: { flex: 1.2, paddingRight: 6 },
  amt: { flex: 1.2, textAlign: 'right' },
  totalRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 6, borderTopWidth: 1, borderTopColor: t.ink, fontWeight: 'bold' },
  sign: { marginTop: 34, flexDirection: 'row', justifyContent: 'space-between' },
  signBox: { flex: 1, marginRight: 24, borderTopWidth: 0.8, borderTopColor: t.ink, paddingTop: 5 },
  footer: { position: 'absolute', bottom: 26, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between' }
});

function scheduleDocument({ org, run, lines, themeName }) {
  registerFonts();
  const t = theme(themeName || undefined);
  const s = pdfStyles(t);
  const list = rows(lines);
  const period = run ? periodName(run.period_year, run.period_month) : '';

  return e(Document, { title: 'Salary payment schedule ' + period, author: (org && org.name) || 'Profitna' },
    e(Page, { size: 'A4', style: s.page, wrap: true },
      e(View, { style: s.rule },
        e(View, { style: s.between },
          e(View, null,
            e(Text, { style: s.org }, (org && org.name) || ''),
            e(Text, { style: s.muted }, 'Salary payment schedule')),
          e(View, { style: { alignItems: 'flex-end' } },
            e(Text, { style: s.heading }, period),
            run && run.pay_date ? e(Text, { style: s.muted }, 'Pay date ' + run.pay_date) : null))),

      e(View, { style: s.thead, fixed: true },
        e(Text, { style: s.sn }, 'S/N'),
        e(Text, { style: s.name }, 'EMPLOYEE'),
        e(Text, { style: s.bank }, 'BANK'),
        e(Text, { style: s.acct }, 'ACCOUNT'),
        e(Text, { style: s.amt }, 'NET PAY')),

      ...list.map((r) => e(View, { style: s.tr, key: 'r' + r.sn, wrap: false },
        e(Text, { style: s.sn }, String(r.sn)),
        e(Text, { style: s.name }, r.name),
        e(Text, { style: s.bank }, r.bank),
        e(Text, { style: s.acct }, r.accountNumber),
        e(Text, { style: s.amt }, naira(r.netKobo)))),

      e(View, { style: s.totalRow },
        e(Text, { style: s.sn }, ''),
        e(Text, { style: s.name }, String(list.length) + ' employee' + (list.length === 1 ? '' : 's')),
        e(Text, { style: s.bank }, ''),
        e(Text, { style: s.acct }, 'TOTAL'),
        e(Text, { style: s.amt }, naira(total(list)))),

      // Two signatures, because that is how a Nigerian salary schedule leaves
      // a company and a PDF that cannot be signed is a PDF that gets printed,
      // signed and scanned anyway.
      e(View, { style: s.sign },
        e(View, { style: s.signBox }, e(Text, { style: s.faint }, 'Prepared by')),
        e(View, { style: s.signBox }, e(Text, { style: s.faint }, 'Approved by'))),

      e(View, { style: s.footer, fixed: true },
        e(Text, { style: s.faint }, 'Generated by Profitna'),
        e(Text, {
          style: s.faint,
          render: ({ pageNumber, totalPages }) => 'Page ' + pageNumber + ' of ' + totalPages
        }))));
}

const pdf = (data) => renderToBuffer(scheduleDocument(data));

module.exports = { rows, problems, csv, excel, pdf, scheduleDocument, total };
