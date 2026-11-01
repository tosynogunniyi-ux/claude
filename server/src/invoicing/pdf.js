// The invoice PDF.
//
// Rendered on the server with @react-pdf/renderer, which was chosen over the
// alternatives for three reasons that mattered here:
//
//   It is pure JavaScript. No Chromium, no native build step, nothing that
//   has to be compiled against musl — so the Alpine image stays small and a
//   deploy cannot fail on a binary that will not build.
//
//   It requires cleanly from CommonJS and needs no JSX toolchain. This
//   codebase has no build step and adding one for a PDF would have been the
//   tail wagging the dog, so every element here is React.createElement.
//
//   It paginates properly. A fifty-line invoice becomes three A4 pages with
//   the table header repeated and "Page 2 of 3" in the footer, which is the
//   part that separates a real document from an HTML print view.
//
// THE NAIRA SIGN IS WHY FONTS ARE EMBEDDED. The fourteen built-in PDF fonts
// use WinAnsi encoding, which has no ₦ (U+20A6). Rendered with Helvetica it
// silently becomes 0xA6 — a broken bar — and the invoice goes out with "¦"
// where every amount should be. DejaVu Sans is bundled in assets/fonts and
// registered below, so the glyph is real and the document renders identically
// wherever it is opened.

const fs = require('fs');
const path = require('path');
const React = require('react');
const {
  Document, Page, Text, View, Image, StyleSheet, Font, renderToBuffer
} = require('@react-pdf/renderer');

const money = require('../money');
const { theme } = require('./themes');

const e = React.createElement;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// Registered once per process. @react-pdf keeps its own registry, so calling
// this twice is wasteful rather than wrong — but the guard makes the cost
// obvious rather than hidden.
let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  Font.register({
    family: 'Profitna',
    fonts: [
      { src: path.join(FONT_DIR, 'DejaVuSans.ttf') },
      { src: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), fontWeight: 'bold' }
    ]
  });
  // Long party names and descriptions must break somewhere sensible rather
  // than running off the page. The default hyphenator splits English words in
  // places that look wrong on a Nigerian business name, so it is turned off
  // and wrapping is left to whitespace.
  Font.registerHyphenationCallback((word) => [word]);
  fontsReady = true;
}

const styles = (t) => StyleSheet.create({
  page: {
    paddingTop: t.header === 'bar' ? 0 : 42,
    paddingBottom: 64,
    paddingHorizontal: 42,
    fontSize: 9.5,
    fontFamily: 'Profitna',
    color: t.ink
    // No lineHeight here, deliberately. A unitless lineHeight on the Page
    // makes an absolutely positioned `fixed` block lay out to nothing: the
    // footer stayed in the element tree and was simply never drawn, so every
    // invoice would have gone out with no page numbers and no attribution,
    // and nothing would have said so. Line spacing is set on the text blocks
    // that need it instead, where it cannot reach the footer.
  },
  bar: { backgroundColor: t.accent, paddingVertical: 22, paddingHorizontal: 42, marginBottom: 24 },
  barText: { color: t.accentText },
  heading: {
    fontSize: t.headingSize,
    letterSpacing: t.headingSpacing,
    fontWeight: 'bold'
  },
  ruleUnderHeader: { borderBottomWidth: 1.2, borderBottomColor: t.accent, paddingBottom: 14, marginBottom: 20 },
  row: { flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  muted: { color: t.muted, lineHeight: 1.4 },
  // No lineHeight: this style is used inside the fixed footer, and a
  // lineHeight anywhere in that subtree stops it being drawn at all.
  faint: { color: t.faint, fontSize: 8 },
  // The same thing, for the stacked company address lines, which are not
  // in the footer and do want the extra air.
  faintStacked: { color: t.faint, fontSize: 8, lineHeight: 1.4 },
  label: { color: t.faint, fontSize: 7.5, letterSpacing: 1.1, textTransform: 'uppercase', marginBottom: 3 },
  logo: { width: 104, maxHeight: 46, objectFit: 'contain', marginBottom: 8 },
  block: { flex: 1, paddingRight: 16 },

  thead: {
    flexDirection: 'row',
    backgroundColor: t.tableHead === 'accent' ? t.accent : t.tableHead === 'band' ? t.band : 'transparent',
    borderBottomWidth: t.tableHead === 'rules' ? 1 : 0,
    borderBottomColor: t.ink,
    borderTopWidth: t.tableHead === 'rules' ? 1 : 0,
    borderTopColor: t.ink,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: t.radius
  },
  th: {
    fontSize: 7.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: 'bold',
    color: t.tableHead === 'accent' ? t.accentText : t.muted
  },
  tr: {
    flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 8,
    borderBottomWidth: 0.5, borderBottomColor: t.rule
  },
  cDesc: { flex: 4.2, lineHeight: 1.35 },
  cQty: { flex: 1, textAlign: 'right' },
  cPrice: { flex: 1.6, textAlign: 'right' },
  cTax: { flex: 1.1, textAlign: 'right' },
  cAmount: { flex: 1.8, textAlign: 'right' },

  totals: { marginTop: 14, flexDirection: 'row', justifyContent: 'flex-end' },
  totalsBox: { width: 232 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3.5 },
  grand: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: t.accent, color: t.accentText,
    paddingVertical: 9, paddingHorizontal: 10, marginTop: 6, borderRadius: t.radius
  },
  note: { marginTop: 18, paddingTop: 12, borderTopWidth: 0.5, borderTopColor: t.rule },
  footer: {
    position: 'absolute', bottom: 26, left: 42, right: 42,
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 0.5, borderTopColor: t.rule, paddingTop: 8
    // No lineHeight, here or on the Page. A unitless lineHeight reaching an
    // absolutely positioned `fixed` block makes it lay out to nothing: the
    // footer stayed in the element tree and was simply never drawn, so the
    // invoice would have gone out with no page numbers and no attribution
    // and nothing would have said so. Line spacing is set on the text blocks
    // that need it instead, where it cannot reach this.
  },
  stamp: {
    position: 'absolute', top: 150, left: 150, transform: 'rotate(-24deg)',
    fontSize: 62, fontWeight: 'bold', opacity: 0.1
  }
});

const text = (v) => (v === null || v === undefined ? '' : String(v));

function logoSource(org) {
  if (!org || !org.logo || !org.logo_mime) return null;
  const bytes = Buffer.isBuffer(org.logo) ? org.logo : Buffer.from(org.logo);
  if (!bytes.length) return null;
  return 'data:' + org.logo_mime + ';base64,' + bytes.toString('base64');
}

// A heading, the company, and who it is for.
function header(s, t, org, inv) {
  const src = logoSource(org);
  const identity = [
    org.address, org.phone, org.email, org.website,
    org.tin ? 'TIN: ' + org.tin : null,
    org.rc_number ? 'RC: ' + org.rc_number : null
  ].filter(Boolean);

  const title = e(View, null,
    e(Text, { style: s.heading }, text(inv.documentLabel || 'INVOICE')),
    e(Text, { style: [s.muted, { marginTop: 2 }] }, text(inv.number))
  );

  const company = e(View, { style: { alignItems: 'flex-end', maxWidth: 240 } },
    src ? e(Image, { style: s.logo, src }) : null,
    e(Text, { style: { fontWeight: 'bold' } }, text(org.name)),
    ...identity.map((line, i) => e(Text, { key: i, style: s.faintStacked }, text(line)))
  );

  if (t.header === 'bar') {
    return e(View, null,
      e(View, { style: s.bar },
        e(View, { style: s.between },
          e(View, null,
            e(Text, { style: [s.heading, s.barText] }, text(inv.documentLabel || 'INVOICE')),
            e(Text, { style: [s.barText, { opacity: 0.85, marginTop: 2 }] }, text(inv.number))),
          e(View, { style: { alignItems: 'flex-end' } },
            e(Text, { style: [s.barText, { fontWeight: 'bold' }] }, text(org.name))))),
      e(View, { style: [s.between, { marginBottom: 18 }] },
        e(View), e(View, { style: { alignItems: 'flex-end' } },
          ...identity.map((line, i) => e(Text, { key: i, style: s.faint }, text(line))))));
  }

  return e(View, { style: t.header === 'rule' ? s.ruleUnderHeader : { marginBottom: 20 } },
    e(View, { style: s.between }, title, company));
}

function parties(s, inv) {
  const cell = (label, lines) => e(View, { style: s.block },
    e(Text, { style: s.label }, label),
    ...lines.filter(Boolean).map((l, i) =>
      e(Text, { key: i, style: i === 0 ? { fontWeight: 'bold' } : s.muted }, text(l))));

  const meta = [
    ['Invoice date', inv.issueDate],
    ['Due', inv.dueDate],
    inv.customerReference ? ['Your reference', inv.customerReference] : null,
    inv.purchaseOrder ? ['PO number', inv.purchaseOrder] : null
  ].filter(Boolean);

  return e(View, { style: [s.row, { marginBottom: 18 }] },
    cell('Billed to', [inv.party, inv.billingAddress]),
    inv.shippingAddress ? cell('Shipped to', [inv.party, inv.shippingAddress]) : null,
    e(View, { style: { width: 168 } },
      ...meta.map(([k, v], i) => e(View, { key: i, style: [s.between, { paddingVertical: 1.5 }] },
        e(Text, { style: s.muted }, k),
        e(Text, { style: { fontWeight: 'bold' } }, text(v))))));
}

const TREATMENT_MARK = { zero_rated: '0%', exempt: 'Exempt', no_vat: '—' };

function table(s, lines) {
  const head = e(View, { style: s.thead, fixed: true },
    e(Text, { style: [s.th, s.cDesc] }, 'Description'),
    e(Text, { style: [s.th, s.cQty] }, 'Qty'),
    e(Text, { style: [s.th, s.cPrice] }, 'Unit price'),
    e(Text, { style: [s.th, s.cTax] }, 'VAT'),
    e(Text, { style: [s.th, s.cAmount] }, 'Amount'));

  const rows = lines.map((l, i) => e(View, { key: i, style: s.tr, wrap: false },
    e(View, { style: s.cDesc },
      e(Text, null, text(l.description || '—')),
      l.unit ? e(Text, { style: s.faint }, text(l.unit)) : null),
    e(Text, { style: s.cQty }, String(money.fromQty(l.qty))),
    e(Text, { style: s.cPrice }, money.format(l.unitPrice)),
    e(Text, { style: s.cTax },
      l.treatment === 'standard'
        ? (l.taxBp ? money.fromBasisPoints(l.taxBp) + '%' : '—')
        : TREATMENT_MARK[l.treatment] || '—'),
    e(Text, { style: s.cAmount }, money.format(l.net))));

  return e(View, null, head, ...rows);
}

function totalsBlock(s, t, totals) {
  const line = (label, value, strong) => e(View, { style: s.totalRow },
    e(Text, { style: strong ? { fontWeight: 'bold' } : s.muted }, label),
    e(Text, { style: strong ? { fontWeight: 'bold' } : null }, value));

  const rows = [line('Subtotal', money.format(totals.net))];
  if (totals.discount) rows.push(line('Discount', '-' + money.format(totals.discount)));
  if (totals.tax) rows.push(line('VAT', money.format(totals.tax)));

  return e(View, { style: s.totals },
    e(View, { style: s.totalsBox },
      ...rows,
      e(View, { style: s.grand },
        e(Text, { style: { fontWeight: 'bold' } }, 'Total due'),
        e(Text, { style: { fontWeight: 'bold' } }, money.format(totals.total))),
      // Withholding is not a discount: the invoice is owed in full and this
      // is what the customer transfers after withholding and remitting.
      totals.wht
        ? e(View, { style: { marginTop: 7 } },
          line('Less withholding tax', '-' + money.format(totals.wht)),
          line('Payable now', money.format(totals.payableNow), true),
          e(Text, { style: [s.faint, { marginTop: 3 }] },
            'Withholding tax is remitted to the revenue service by you; please send the receipt.'))
        : null));
}

function notes(s, inv, org) {
  const blocks = [
    [inv.paymentInstructions || org.payment_instructions, 'How to pay'],
    [inv.terms || org.invoice_terms, 'Terms'],
    [inv.notes, 'Notes']
  ].filter(([body]) => body);

  if (!blocks.length) return null;
  return e(View, { style: s.note },
    ...blocks.map(([body, label], i) => e(View, { key: i, style: { marginBottom: 7 } },
      e(Text, { style: s.label }, label),
      e(Text, { style: s.muted }, text(body)))));
}

function footer(s, t, org, inv) {
  return e(View, { style: s.footer, fixed: true },
    e(Text, { style: s.faint }, text(org.name) + (inv.number ? ' · ' + inv.number : '')),
    // The product's one piece of branding on a customer's document. Small,
    // and it earns its place by being the only mention.
    e(Text, { style: s.faint }, 'Powered by Profitna · profitna.com'),
    e(Text, {
      style: s.faint,
      render: ({ pageNumber, totalPages }) => 'Page ' + pageNumber + ' of ' + totalPages
    }));
}

// The whole document. `data` is already-computed figures — this renders, it
// does not calculate, so the PDF cannot disagree with the screen.
function invoiceDocument(data) {
  registerFonts();
  const t = theme(data.template, data.brand);
  const s = styles(t);
  const org = data.org || {};
  const inv = data.invoice || {};

  return e(Document, {
    title: (inv.documentLabel || 'Invoice') + ' ' + text(inv.number),
    author: text(org.name),
    creator: 'Profitna',
    producer: 'Profitna'
  },
  e(Page, { size: 'A4', style: s.page, wrap: true },
    inv.watermark
      ? e(Text, { style: [s.stamp, { color: t.accent }], fixed: true }, text(inv.watermark))
      : null,
    header(s, t, org, inv),
    parties(s, inv),
    table(s, data.lines || []),
    totalsBlock(s, t, data.totals || { net: 0, tax: 0, total: 0 }),
    notes(s, inv, org),
    footer(s, t, org, inv)));
}

// Buffer rather than a stream: an invoice is small, and having the whole
// thing before any of it is sent means a render that fails halfway produces
// an error page rather than a truncated download.
function render(data) {
  return renderToBuffer(invoiceDocument(data));
}

module.exports = { render, invoiceDocument, registerFonts, logoSource };
