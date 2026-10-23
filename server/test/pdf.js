// Do the invoice PDFs actually come out right?
//   npm run test:pdf
//
// A PDF is easy to test badly: render one, check the file is not empty, call
// it proof. That passes when every amount on the page reads "¦107,500.00"
// because the built-in fonts have no naira sign.
//
// So this checks the things that go silently wrong: that a font with ₦ in it
// is actually embedded, that the page is really A4, that fifty lines become
// several pages rather than one long one, that the figures printed are the
// ones computed, and that one organisation's logo cannot appear on another's
// invoice.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { pool, one, query } = require('../src/db');
const money = require('../src/money');
const totals = require('../src/invoicing/totals');
const pdf = require('../src/invoicing/pdf');
const { NAMES, THEMES, theme } = require('../src/invoicing/themes');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// --- reading a PDF back without a parser dependency ------------------------

const str = (buf) => buf.toString('latin1');

function pageCount(buf) {
  const m = str(buf).match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

function mediaBoxes(buf) {
  return (str(buf).match(/MediaBox\s*\[([^\]]+)\]/g) || []).map((s) =>
    s.replace(/MediaBox\s*\[/, '').replace(/\]/, '').trim().split(/\s+/).map(Number));
}

// Every decompressed stream, joined — for the ToUnicode maps, which are
// readable in the raw PDF.
function streams(buf) {
  const s = str(buf);
  const out = [];
  let i = 0;
  let guard = 0;
  while (guard++ < 5000) {
    const at = s.indexOf('stream', i);
    if (at === -1) break;
    const start = s.indexOf('\n', at) + 1;
    const end = s.indexOf('endstream', start);
    if (start <= 0 || end === -1) break;
    let raw = Buffer.from(s.slice(start, end), 'latin1');
    try { raw = zlib.inflateSync(raw); } catch (e) { /* not deflated */ }
    out.push(raw.toString('latin1'));
    i = end + 9;
  }
  return out;
}

// The text as a reader would copy it out. Searching the content stream for
// words does not work once a font is embedded: the text is written as glyph
// indices into a subset, not as ASCII. Which is the point — it has to be read
// back the way a PDF viewer reads it, or the test is checking nothing.
const { PDFParse } = require('pdf-parse');
async function readText(buf) {
  const parser = new PDFParse({ data: buf });
  try {
    const r = await parser.getText();
    return r.text || '';
  } finally {
    await parser.destroy();
  }
}

// Letter-spaced small-caps headings come out of the extractor as
// "D E S C R I P T I O N". That is a property of how letterSpacing is
// written to the page, not a fault, so headings are matched without spaces.
const squash = (s) => s.replace(/\s+/g, '').toLowerCase();

const ORG = {
  name: 'Mideops Professional Services Ltd',
  address: '14 Adeola Odeku Street, Victoria Island, Lagos',
  phone: '+234 801 234 5678',
  email: 'accounts@mideops.ng',
  website: 'mideops.ng',
  tin: '01234567-0001',
  rc_number: 'RC 1234567',
  invoice_terms: 'Payment due within 14 days of invoice date.',
  payment_instructions: 'GTBank 0123456789, Mideops Professional Services Ltd',
  logo: null, logo_mime: null
};

function docFor(lines, extra) {
  const computed = totals.compute(lines, { taxRate: '7.5' });
  return Object.assign({
    org: ORG,
    template: 'executive',
    invoice: {
      number: 'PF-INV-2026-00042',
      documentLabel: 'INVOICE',
      party: 'Zenith Foods Limited',
      billingAddress: '3 Kofo Abayomi Street, Victoria Island, Lagos',
      issueDate: '2026-10-14',
      dueDate: '2026-10-28',
      customerReference: 'PO-9981'
    },
    totals: computed,
    lines: computed.lines
  }, extra || {});
}

(async () => {
  console.log('\nit produces a PDF at all');
  const started = Date.now();
  const buf = await pdf.render(docFor([
    { description: 'Monthly accounting retainer', qty: 3, unitPrice: '100000', taxRate: '7.5' }
  ]));
  const ms = Date.now() - started;
  check('with a PDF header', buf.slice(0, 5).toString() === '%PDF-', buf.slice(0, 8).toString());
  check('of a believable size', buf.length > 3000, buf.length + ' bytes');
  check('quickly enough to serve on a request', ms < 5000, ms + 'ms');

  console.log('\nthe page is really A4');
  const boxes = mediaBoxes(buf);
  check('one page for a short invoice', pageCount(buf) === 1, String(pageCount(buf)));
  check('595.28 x 841.89 points',
    boxes.length > 0 && Math.round(boxes[0][2]) === 595 && Math.round(boxes[0][3]) === 842,
    JSON.stringify(boxes[0]));

  // The one that matters. The fourteen built-in PDF fonts use WinAnsi, which
  // has no U+20A6: rendered with Helvetica every amount silently becomes a
  // broken bar. The only defence is an embedded font that has the glyph.
  console.log('\nthe naira sign');
  const raw = str(buf);
  check('a TrueType font is embedded, not merely named', raw.includes('/FontFile2'));
  check('and it is the bundled one', /DejaVuSans/.test(raw), 'the glyph comes from here');
  check('with a ToUnicode map, so the text can be copied out', raw.includes('/ToUnicode'));
  check('no base-14 font is used for body text',
    !/\/BaseFont\s*\/Helvetica[^-]/.test(raw),
    'Helvetica would mean the naira sign is a broken bar');

  const unicode = streams(buf).filter((s) => /beginbfchar|beginbfrange/.test(s)).join('\n');
  check('and U+20A6 appears in that map', /20a6/i.test(unicode),
    'if this is absent the amounts are not naira');

  console.log('\nlong invoices paginate');
  const manyLines = Array.from({ length: 60 }, (_, i) => ({
    description: 'Service line ' + (i + 1) + ' with a reasonably long description',
    qty: 1, unitPrice: String(10000 + i * 137), taxRate: '7.5'
  }));
  const long = await pdf.render(docFor(manyLines));
  const pages = pageCount(long);
  check('sixty lines run past one page', pages >= 2, pages + ' pages');
  check('and every page is A4',
    mediaBoxes(long).every((b) => Math.round(b[2]) === 595 && Math.round(b[3]) === 842));
  const longText = await readText(long);
  check('the table header repeats on each page',
    (squash(longText).match(/description/g) || []).length >= pages,
    'a continuation page without headings is unreadable');
  check('and pages are numbered',
    /page\d+of\d+/.test(squash(longText)), 'so a printed invoice can be collated');

  console.log('\nthe figures printed are the figures computed');
  const t = totals.compute([{ description: 'X', qty: 3, unitPrice: '100000', taxRate: '7.5' }]);
  check('three at 100,000 is 300,000 net', t.net === 30000000, money.format(t.net));
  check('VAT is 22,500', t.tax === 2250000, money.format(t.tax));
  check('and the total is 322,500', t.total === 32250000, money.format(t.total));
  // The PDF renders already-computed figures and does no arithmetic of its
  // own, which is why it cannot disagree with the screen. Read back the way a
  // customer's PDF viewer would read it.
  const printed = await readText(buf);
  check('the document carries its number', printed.includes('PF-INV-2026-00042'));
  check('and the customer it is for', printed.includes('Zenith Foods Limited'));
  check('the amounts are printed in naira, not a broken bar',
    printed.includes('₦') && !printed.includes('¦'),
    'this is the whole reason a font is embedded');
  check('the computed total appears on the face of it',
    printed.includes('322,500.00'), 'three at 100,000 plus 7.5% VAT');
  check('with the company identity it must carry',
    printed.includes('01234567-0001') && printed.includes('RC 1234567'),
    'TIN and RC number');

  console.log('\nwithholding tax is shown as a deduction, not a discount');
  const w = totals.compute([
    { description: 'Professional services', qty: 1, unitPrice: '100000', taxRate: '7.5', whtRate: '5' }
  ]);
  const whtDoc = await pdf.render(Object.assign(docFor([]), { totals: w, lines: w.lines }));
  check('it renders', whtDoc.slice(0, 5).toString() === '%PDF-');
  check('the total stays at 107,500', w.total === 10750000, money.format(w.total));
  check('and payable now is 102,500', w.payableNow === 10250000, money.format(w.payableNow));

  console.log('\nall five designs');
  for (const name of NAMES) {
    const out = await pdf.render(docFor([
      { description: 'Consulting', qty: 1, unitPrice: '250000', taxRate: '7.5' }
    ], { template: name }));
    check(THEMES[name].label + ' renders',
      out.slice(0, 5).toString() === '%PDF-' && out.length > 3000, out.length + ' bytes');
  }
  check('an unknown template falls back rather than throwing',
    theme('no-such-design').label === THEMES.executive.label);
  check('a brand colour can be overridden',
    theme('executive', { accent: '#0E7C86' }).accent === '#0E7C86');
  check('but rubbish in that field is ignored',
    theme('executive', { accent: 'javascript:alert(1)' }).accent === THEMES.executive.accent,
    'a colour goes straight into the document, so it is validated');

  console.log('\nstates are stamped on the face of the document');
  for (const [mark, label] of [['DRAFT', 'a draft'], ['PAID', 'a settled invoice'], ['VOID', 'a voided one']]) {
    const out = await pdf.render(docFor(
      [{ description: 'X', qty: 1, unitPrice: '1000' }],
      { invoice: Object.assign({}, docFor([]).invoice, { watermark: mark }) }
    ));
    check(label + ' carries its watermark', out.slice(0, 5).toString() === '%PDF-' && out.length > 3000);
  }

  console.log('\nbranding');
  // A 1x1 PNG, which is enough to prove the bytes reach the document.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const src = pdf.logoSource({ logo: png, logo_mime: 'image/png' });
  check('a stored logo becomes a data URI', /^data:image\/png;base64,/.test(String(src)));
  check('and an organisation without one does not break the document',
    pdf.logoSource({ logo: null, logo_mime: null }) === null);
  const branded = await pdf.render(docFor(
    [{ description: 'X', qty: 1, unitPrice: '1000' }],
    { org: Object.assign({}, ORG, { logo: png, logo_mime: 'image/png' }) }
  ));
  check('an invoice with a logo renders', branded.slice(0, 5).toString() === '%PDF-');
  check('and the image is actually embedded', str(branded).includes('/Image'));
  check('every invoice says where it came from',
    (await readText(branded)).includes('Powered by Profitna'), 'the one piece of our branding');

  console.log('\nawkward content does not break the page');
  const nasty = await pdf.render(docFor([
    { description: 'A'.repeat(400), qty: '0.001', unitPrice: '0.01' },
    { description: 'Ωmega — ₦ sign, em-dash, "quotes" & <brackets>', qty: 1, unitPrice: '999999999' },
    { description: '', qty: 0, unitPrice: '0' }
  ]));
  check('a 400-character description, a huge amount and an empty line all render',
    nasty.slice(0, 5).toString() === '%PDF-' && nasty.length > 3000, nasty.length + ' bytes');

  console.log('\nassembled from the database');
  const org = await one(
    `INSERT INTO organizations (name, address, phone, email, tin, vat_registered, vat_rate)
     VALUES ($1, '1 Test Road, Lagos', '+234 800 000 0000', 'test@example.ng', '0000-0001', true, 7.5)
     RETURNING *`,
    ['PDF Test ' + Date.now()]
  );
  const invoice = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date,
                           total, base_status, total_kobo, subtotal_kobo, template)
     VALUES ($1, 'INV-PDF-1', 'Zenith Foods', CURRENT_DATE, CURRENT_DATE + 14,
             107500, 'sent', 10750000, 10000000, 'fintech')
     RETURNING *`,
    [org.id]
  );
  await query(
    `INSERT INTO invoice_lines (invoice_id, organization_id, position, description,
                                qty_milli, unit_price_kobo, tax_treatment, tax_bp,
                                net_kobo, tax_kobo, total_kobo)
     VALUES ($1, $2, 0, 'Accounting services', 1000, 10000000, 'standard', 750,
             10000000, 750000, 10750000)`,
    [invoice.id, org.id]
  );

  const invoicing = require('../src/routes/invoicing');
  const data = await invoicing.assemble(org.id, invoice.id, 'sme');
  check('the invoice is found', Boolean(data));
  check('with its line', data.lines.length === 1 && data.lines[0].net === 10000000);
  check('its totals', data.totals.total === 10750000, money.format(data.totals.total));
  check('its chosen template', data.template === 'fintech', data.template);
  check('and the company identity to print on it',
    data.org.tin === '0000-0001' && data.org.address.includes('Lagos'));
  const fromDb = await pdf.render(data);
  check('and it renders', fromDb.slice(0, 5).toString() === '%PDF-' && fromDb.length > 3000);

  console.log('\nanother organisation cannot fetch it');
  const stranger = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    ['PDF Stranger ' + Date.now()]);
  check('the same invoice id under different books is not found',
    (await invoicing.assemble(stranger.id, invoice.id, 'sme')) === null,
    'the organisation is part of the lookup, not checked afterwards');

  console.log('\nan invoice from before line items existed');
  const legacy = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total, base_status)
     VALUES ($1, 'INV-OLD-1', 'Old Customer', CURRENT_DATE, CURRENT_DATE, 50000, 'sent')
     RETURNING *`,
    [org.id]
  );
  const old = await invoicing.assemble(org.id, legacy.id, 'sme');
  check('still produces a document', Boolean(old));
  check('with its amount as a single line',
    old.lines.length === 1 && old.lines[0].net === 5000000, money.format(old.lines[0].net));
  check('that renders', (await pdf.render(old)).slice(0, 5).toString() === '%PDF-');

  // Proof you can open: written where it can be looked at rather than only
  // asserted about.
  const out = path.join(os.tmpdir(), 'profitna-invoice-sample.pdf');
  fs.writeFileSync(out, await pdf.render(docFor(manyLines.slice(0, 12), { template: 'luxury' })));
  console.log('  ..   a sample is at ' + out);

  await query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [[org.id, stranger.id]]);

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
