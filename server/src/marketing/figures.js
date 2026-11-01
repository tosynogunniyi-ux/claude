// The pictures.
//
// Drawn, not photographed. Every figure on these pages is inline SVG or a CSS
// bar: no image request, nothing that arrives after the text, both themes out
// of the same tokens, and a label a screen reader can read. A stock photograph
// of somebody pointing at a laptop would cost 200 KB and say nothing; these
// say what the product actually does.
//
// The motion lives in the stylesheet (render.js), not here, so that one
// `prefers-reduced-motion` rule turns all of it off at once.

const { esc } = require('./render');
const statutory = require('../payroll/statutory');
const pricing = require('../pricing');

const naira = (n) => '\u20a6' + n.toLocaleString('en-NG');

const ICONS = {
  invoice: '<path d="M6 3h9l3 3v15l-2.2-1.4L13.6 21l-2.3-1.4L9 21l-2.3-1.4L4 21V3z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
  ledger: '<path d="M12 5v15"/><path d="M4 8h7M13 8h7"/><path d="M7.5 8 4 15h7zM16.5 8 13 15h7z"/><path d="M8 20h8"/>',
  payroll: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6"/><path d="M18 20c0-2-.8-3.8-2-5"/>',
  percent: '<circle cx="7.5" cy="7.5" r="2.8"/><circle cx="16.5" cy="16.5" r="2.8"/><path d="M19 5 5 19"/>',
  roles: '<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><circle cx="12" cy="11" r="2.2"/><path d="M8.4 17c.7-1.6 2-2.5 3.6-2.5s2.9.9 3.6 2.5"/>',
  books: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  check: '<path d="M4 12.5 9 17.5 20 6.5"/>',
  kobo: '<circle cx="12" cy="12" r="8.5"/><path d="M9 8v8M15 8v8M7.5 11h9M7.5 14h9"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M3.5 10.5h17"/>',
  export: '<path d="M12 3v11"/><path d="M8 7l4-4 4 4"/><path d="M4 15v4.5h16V15"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.8 7 7.1 5.4a2 2 0 0 0 2.2 0L20.2 7"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  company: '<path d="M4 20V7.5L12 4l8 3.5V20"/><path d="M4 20h16"/><path d="M9.5 20v-5h5v5"/><path d="M8 10h2M14 10h2"/>'
};

const icon = (name, size) => '<svg width="' + (size || 24) + '" height="' + (size || 24) +
  '" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  ICONS[name] + '</svg>';

// The hero picture: one invoice becoming a set of books. A vertical rail with
// three stops, because that is the actual mechanism — the document, the
// journal it posts, the statement that comes out — and a picture of the
// mechanism is worth more than a screenshot of a dashboard.
const heroArt = () => `
<figure>
<div class="art">
<svg viewBox="0 0 400 344" role="img" width="400" height="344"
     aria-label="An invoice for 1,250,000 naira posts a journal entry whose debits and credits are equal, and the journal feeds the monthly statements.">
  <title>One invoice becomes a set of books</title>
  <defs>
    <style>
      .pane{fill:var(--band);stroke:var(--line);stroke-width:1}
      .lbl{font:600 11px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.1em}
      .txt{font:500 13px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--ink)}
      .dim{font:400 11.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
      .rule{stroke:var(--line);stroke-width:1}
      .ghost{fill:var(--line-2)}
    </style>
  </defs>

  <!-- the rail -->
  <path d="M24 56V282" stroke="var(--line)" stroke-width="2"/>
  <circle cx="24" cy="56" r="6.5" fill="var(--gold)"/>
  <circle cx="24" cy="170" r="6.5" fill="var(--gold)"/>
  <circle cx="24" cy="282" r="6.5" fill="var(--gold)"/>

  <!-- 1. the invoice -->
  <g transform="translate(48 14)">
    <rect class="pane" x="0" y="0" width="340" height="92" rx="10"/>
    <text class="lbl" x="18" y="26">INVOICE</text>
    <rect class="ghost" x="18" y="38" width="150" height="7" rx="3.5"/>
    <rect class="ghost" x="18" y="53" width="112" height="7" rx="3.5"/>
    <rect class="ghost" x="18" y="68" width="134" height="7" rx="3.5"/>
    <rect x="206" y="34" width="116" height="44" rx="8" fill="var(--card)" stroke="var(--line)"/>
    <text class="dim" x="218" y="51">Total due</text>
    <text class="txt" x="218" y="69" font-weight="600">&#8358;1,250,000</text>
  </g>

  <!-- 2. the journal it posts -->
  <g transform="translate(48 118)">
    <rect class="pane" x="0" y="0" width="340" height="104" rx="10"/>
    <text class="lbl" x="18" y="26">JOURNAL</text>
    <text class="dim" x="188" y="26">Dr</text>
    <text class="dim" x="268" y="26">Cr</text>
    <path d="M18 34H322" class="rule"/>
    <text class="dim" x="18" y="54">Receivables</text>
    <text class="txt" x="188" y="54">1,250,000</text>
    <text class="dim" x="18" y="74">Sales &#183; VAT</text>
    <text class="txt" x="268" y="74">1,250,000</text>
    <path d="M188 82H322" class="rule"/>
    <g transform="translate(234 86)">
      <rect x="0" y="0" width="88" height="22" rx="11" fill="color-mix(in srgb,var(--gold) 16%,var(--card))"/>
      <path d="M12 11.5 15.5 15 21 8" fill="none" stroke="var(--gold)" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round"/>
      <text class="dim" x="29" y="15">balanced</text>
    </g>
  </g>

  <!-- 3. what comes out: one series, labelled, no invented axis -->
  <g transform="translate(48 240)">
    <rect class="pane" x="0" y="0" width="340" height="84" rx="10"/>
    <text class="lbl" x="18" y="24">STATEMENTS</text>
    <g>
      <rect x="156" y="42" width="15" height="18" rx="3" fill="var(--c1)"/>
      <rect x="179" y="34" width="15" height="26" rx="3" fill="var(--c2)"/>
      <rect x="202" y="27" width="15" height="33" rx="3" fill="var(--c3)"/>
      <rect x="225" y="37" width="15" height="23" rx="3" fill="var(--c4)"/>
      <rect x="248" y="21" width="15" height="39" rx="3" fill="var(--c5)"/>
      <rect x="271" y="31" width="15" height="29" rx="3" fill="var(--c4)"/>
      <rect x="294" y="16" width="15" height="44" rx="3" fill="var(--c5)"/>
      <path d="M150 62H318" class="rule"/>
    </g>
    <text class="dim" x="18" y="50">Trial balance</text>
    <text class="dim" x="18" y="68">P&amp;L &#183; Balance sheet</text>
  </g>
</svg>
</div>
<figcaption>One invoice, the entry it posts, and the statements that come out of it. Illustration &mdash; your own figures, your own logo.</figcaption>
</figure>`;

// A strip of plain facts, each one a thing in the repository rather than a
// claim about the market.
const chips = (items) => `
<section style="padding:30px 0"><div class="wrap">
  <div class="chips">
    ${items.map(([ic, text]) => '<span class="chip">' + icon(ic, 18) + esc(text) + '</span>').join('')}
  </div>
</div></section>`;

// The PAYE bands, drawn from the frozen 2026 rule set the payroll engine
// actually calculates with, so this picture cannot drift away from the
// payslips. A table with the bars drawn inside it: the figures stay readable
// as figures, and there is no second version of the data to disagree with.
const paye = (title, intro, note, band) => {
  const rules = statutory.rulesFor(new Date().toISOString().slice(0, 10));
  // "2026-01-01" is a date a lawyer writes; "1 January 2026" is one a reader
  // reads.
  const longDate = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return d + ' ' + months[m - 1] + ' ' + y;
  };
  const money = (kobo) => {
    const n = kobo / 100;
    if (n >= 1000000) {
      const m = n / 1000000;
      return '&#8358;' + (m % 1 === 0 ? m : m.toFixed(1)) + 'm';
    }
    return '&#8358;' + n.toLocaleString('en-NG');
  };
  const top = Math.max(...rules.bands.map((b) => b.rateBp)) / 100;   // 25
  const rows = rules.bands.map((band, i) => {
    const rate = band.rateBp / 100;
    const label = band.width === Infinity
      ? 'Everything above ' + money(rules.bands.slice(0, i).reduce((a, b) => a + b.width, 0))
      : (i === 0 ? 'First ' : 'The next ') + money(band.width);
    const hue = 'var(--c' + Math.min(5, Math.max(1, i)) + ')';
    const w = rate === 0 ? 0 : Math.round((rate / top) * 1000) / 10;
    const bar = rate === 0
      ? 'width:0;min-width:0'
      : 'width:' + w + '%;background:' + hue;
    return `<tr>
      <th scope="row">${label}</th>
      <td><span class="track"><span class="bar" style="${bar}"
        title="${rate}% on ${label.toLowerCase()}"></span></span><span class="rate">${rate}%</span></td>
    </tr>`;
  }).join('');

  return `
<section${band ? ' class="band"' : ''}><div class="wrap">
  <h2>${esc(title)}</h2>
  <p class="lede" style="margin-bottom:28px">${intro}</p>
  <figure class="fig">
    <table class="bars">
      <caption>${esc(rules.label)} &middot; in force from ${esc(longDate(rules.effectiveFrom))}. Annual taxable income after reliefs, and the rate each slice of it is taxed at.</caption>
      <thead><tr><th scope="col">Slice of taxable income</th><th scope="col">Rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </figure>
  <p class="note" style="margin-top:16px">${note}</p>
</div></section>`;
};

const BRAND_INK = '#171612';
const BRAND_CREAM = '#EDEAE2';
const BRAND_GOLD = '#FAC775';
const BRAND_FAINT = '#8A8578';

// --------------------------------------------------------------- the frame
//
// Every figure is the same shape: a titled panel, a caption under it, and an
// aria-label that says in a sentence what somebody looking at it would see.
// `wide` drops the panel chrome for a figure that is already a document.
const figure = ({ svg, caption, align }) => `
<figure class="fig-art${align === 'tall' ? ' tall' : ''}">
  <div class="art">${svg}</div>
  ${caption ? '<figcaption>' + caption + '</figcaption>' : ''}
</figure>`;

const svgOpen = (w, h, label) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">`;

// A sheet of A4, drawn. Used for the invoice and the payslip, so the two are
// recognisably the same stationery.
const sheet = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="var(--card)" stroke="var(--line)"/>`;

const ghost = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h || 7}" rx="${(h || 7) / 2}" fill="var(--line-2)"/>`;

// ------------------------------------------------------------- the invoice
//
// What a customer is actually sent: your mark at the top, the lines, VAT on
// its own line because it is somebody else's money, and a total.
const invoiceArt = () => figure({
  svg: svgOpen(360, 300, 'An invoice on A4: a branded header, three priced lines, VAT at 7.5% ' +
    'on its own line, and a total of 1,344,375 naira.') + `
  <style>
    .inv-t{font:600 12px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--ink)}
    .inv-d{font:400 10.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
    .inv-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
    .inv-n{font:500 10.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
    .inv-r{stroke:var(--line-2);stroke-width:1}
  </style>
  ${sheet(10, 8, 340, 284)}
  <rect x="10" y="8" width="340" height="52" rx="8" fill="${BRAND_INK}"/>
  <rect x="10" y="46" width="340" height="14" fill="${BRAND_INK}"/>
  <text x="28" y="31" style="font:700 15px 'Familjen Grotesk',system-ui,sans-serif" fill="${BRAND_CREAM}">PROFIT<tspan fill="${BRAND_GOLD}">NA</tspan></text>
  <path d="M250 36 L262 24 L269 31 L281 19" fill="none" stroke="${BRAND_GOLD}" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round" class="draw" style="--len:60"/>
  <text x="28" y="48" class="inv-k" fill="${BRAND_GOLD}">INVOICE &#183; INV-2026-0184</text>

  <text x="28" y="84" class="inv-d">Billed to</text>
  <text x="28" y="100" class="inv-t">Bluecrest Logistics Ltd</text>
  ${ghost(28, 108, 120, 6)}

  <text x="232" y="84" class="inv-d">Due</text>
  <text x="232" y="100" class="inv-t">30 Nov 2026</text>

  <path d="M28 126H332" class="inv-r"/>
  <text x="28" y="144" class="inv-d">Haulage &#183; Lagos to Kano</text><text x="332" y="144" class="inv-n" text-anchor="end">850,000</text>
  <text x="28" y="166" class="inv-d">Warehousing, 2 weeks</text><text x="332" y="166" class="inv-n" text-anchor="end">340,000</text>
  <text x="28" y="188" class="inv-d">Handling</text><text x="332" y="188" class="inv-n" text-anchor="end">60,000</text>
  <path d="M28 202H332" class="inv-r"/>
  <text x="28" y="222" class="inv-d">Subtotal</text><text x="332" y="222" class="inv-n" text-anchor="end">1,250,000</text>
  <text x="28" y="242" class="inv-d">VAT at 7.5%</text><text x="332" y="242" class="inv-n" text-anchor="end">93,750</text>
  <rect x="184" y="252" width="148" height="30" rx="7" fill="color-mix(in srgb,var(--gold) 14%,var(--card))"/>
  <text x="196" y="271" class="inv-d">Total</text>
  <text x="320" y="271" style="font:600 12px 'IBM Plex Mono',ui-monospace,monospace" fill="var(--ink)" text-anchor="end">&#8358;1,343,750</text>
</svg>`,
  caption: 'Five A4 designs, your logo and your details. Illustration.'
});

// ------------------------------------------------------------- the payslip
const payslipArt = () => figure({
  svg: svgOpen(360, 300, 'A payslip showing gross pay of 450,000 naira, PAYE, pension and NHF ' +
    'deducted, and net pay of 372,750 naira, beside two rows of a bank payment schedule.') + `
  <style>
    .ps-t{font:600 12px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--ink)}
    .ps-d{font:400 10.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
    .ps-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
    .ps-n{font:500 10.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
    .ps-r{stroke:var(--line-2);stroke-width:1}
  </style>
  ${sheet(10, 8, 340, 196)}
  <text x="28" y="32" class="ps-k">PAYSLIP &#183; NOVEMBER 2026</text>
  <text x="28" y="52" class="ps-t">Chidinma Okafor</text>
  <text x="28" y="68" class="ps-d">Operations &#183; Lagos</text>
  <path d="M28 80H332" class="ps-r"/>
  <text x="28" y="98" class="ps-d">Gross pay</text><text x="332" y="98" class="ps-n" text-anchor="end">450,000</text>
  <text x="28" y="118" class="ps-d">PAYE</text><text x="332" y="118" class="ps-n" text-anchor="end">&#8722;39,750</text>
  <text x="28" y="138" class="ps-d">Pension, 8% of basic + housing + transport</text><text x="332" y="138" class="ps-n" text-anchor="end">&#8722;28,800</text>
  <text x="28" y="158" class="ps-d">NHF, 2.5% of basic</text><text x="332" y="158" class="ps-n" text-anchor="end">&#8722;8,700</text>
  <rect x="192" y="168" width="140" height="28" rx="7" fill="color-mix(in srgb,var(--gold) 14%,var(--card))"/>
  <text x="204" y="186" class="ps-d">Net pay</text>
  <text x="320" y="186" style="font:600 12px 'IBM Plex Mono',ui-monospace,monospace" fill="var(--ink)" text-anchor="end">372,750</text>

  ${sheet(10, 216, 340, 76)}
  <text x="28" y="238" class="ps-k">BANK SCHEDULE</text>
  <path d="M28 246H332" class="ps-r"/>
  <text x="28" y="264" class="ps-d">C. Okafor &#183; GTBank</text><text x="332" y="264" class="ps-n" text-anchor="end">372,750</text>
  <text x="28" y="282" class="ps-d">A. Bello &#183; Zenith</text><text x="332" y="282" class="ps-n" text-anchor="end">298,400</text>
</svg>`,
  caption: 'Payslips and the bank schedule that pays them. Illustration &mdash; the figures are ' +
    'worked by the same engine that runs a real payroll.'
});

// -------------------------------------------------------------- the ledger
//
// Two T-accounts and the trial balance underneath them: the whole argument
// for double entry in one picture.
const ledgerArt = () => figure({
  svg: svgOpen(360, 268, 'Two T-accounts, receivables and sales, with equal debits and credits, ' +
    'and a trial balance underneath showing both sides at 1,343,750 naira.') + `
  <style>
    .lg-h{font:600 10.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--ink)}
    .lg-d{font:400 10px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
    .lg-n{font:500 10.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
    .lg-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
  </style>
  ${sheet(10, 8, 164, 150)}
  <text x="26" y="30" class="lg-h">Receivables</text>
  <path d="M26 40H158M92 46V142" stroke="var(--line)" stroke-width="1.5"/>
  <text x="34" y="60" class="lg-d">Dr</text><text x="100" y="60" class="lg-d">Cr</text>
  <text x="34" y="82" class="lg-n">1,343,750</text>
  <text x="34" y="104" class="lg-d">invoice</text>

  ${sheet(186, 8, 164, 150)}
  <text x="202" y="30" class="lg-h">Sales &#183; VAT</text>
  <path d="M202 40H334M268 46V142" stroke="var(--line)" stroke-width="1.5"/>
  <text x="210" y="60" class="lg-d">Dr</text><text x="276" y="60" class="lg-d">Cr</text>
  <text x="276" y="82" class="lg-n">1,250,000</text>
  <text x="276" y="104" class="lg-n">93,750</text>

  ${sheet(10, 172, 340, 88)}
  <text x="26" y="194" class="lg-k">TRIAL BALANCE</text>
  <path d="M26 202H334" stroke="var(--line-2)"/>
  <text x="26" y="222" class="lg-d">Total debits</text><text x="334" y="222" class="lg-n" text-anchor="end">1,343,750</text>
  <text x="26" y="242" class="lg-d">Total credits</text><text x="334" y="242" class="lg-n" text-anchor="end">1,343,750</text>
  <g transform="translate(26 228)">
    <rect x="0" y="0" width="92" height="22" rx="11" fill="color-mix(in srgb,var(--gold) 16%,var(--card))"/>
    <path d="M12 11.5 15.5 15 21 8" fill="none" stroke="var(--gold)" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" class="draw" style="--len:22"/>
    <text x="29" y="15" class="lg-d">it balances</text>
  </g>
</svg>`,
  caption: 'Debits equal credits or the entry is refused. Illustration.'
});

// ------------------------------------------------------ receivables ageing
//
// One series, sequential ramp, every bar labelled — the oldest column is the
// one a trader needs to see, so it is the darkest and it is named.
const ageingArt = () => {
  const buckets = [
    ['Not yet due', 1840, 'var(--c1)'],
    ['1&#8211;30 days', 1260, 'var(--c2)'],
    ['31&#8211;60 days', 640, 'var(--c3)'],
    ['61&#8211;90 days', 310, 'var(--c4)'],
    ['Over 90 days', 180, 'var(--c5)']
  ];
  const top = 1840;
  const bars = buckets.map((b, i) => {
    const h = Math.round((b[1] / top) * 120);
    const x = 30 + i * 62;
    return `<rect x="${x}" y="${170 - h}" width="34" height="${h}" rx="4" fill="${b[2]}"
      class="grow" style="animation-delay:${i * 90}ms"><title>${b[0].replace(/&#8211;/g, '-')}: ₦${b[1].toLocaleString('en-NG')},000</title></rect>
      <text x="${x + 17}" y="${164 - h}" class="ag-v" text-anchor="middle">${(b[1] / 1000).toFixed(2)}m</text>
      <text x="${x + 17}" y="190" class="ag-l" text-anchor="middle">${b[0]}</text>`;
  }).join('');
  return figure({
    svg: svgOpen(360, 212, 'A receivables ageing chart: 1.84m naira not yet due, 1.26m one to ' +
      'thirty days old, 640,000 thirty-one to sixty, 310,000 sixty-one to ninety, and 180,000 ' +
      'over ninety days old.') + `
    <style>
      .ag-l{font:400 9px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
      .ag-v{font:600 9.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
      .ag-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
    </style>
    <text x="30" y="24" class="ag-k">WHO OWES YOU, AND FOR HOW LONG</text>
    <path d="M24 170H346" stroke="var(--line)" stroke-width="1"/>
    ${bars}
  </svg>`,
    caption: 'The column on the right is the one that costs you money. Illustration.'
  });
};

// --------------------------------------------------- funds, for the church
const fundsArt = () => {
  const funds = [
    ['General', 62, 'var(--c2)'],
    ['Building', 24, 'var(--c4)'],
    ['Missions', 9, 'var(--c5)'],
    ['Benevolence', 5, 'var(--c1)']
  ];
  let at = 0;
  const rows = funds.map((f, i) => {
    const x = 30 + (at / 100) * 300;
    const w = (f[1] / 100) * 300;
    at += f[1];
    return `<rect x="${x + 1}" y="60" width="${Math.max(2, w - 2)}" height="26" rx="3" fill="${f[2]}"
      class="grow-x" style="animation-delay:${i * 110}ms"><title>${f[0]}: ${f[1]}% of giving</title></rect>`;
  }).join('');
  const legend = funds.map((f, i) =>
    `<g transform="translate(${30 + (i % 2) * 160} ${110 + Math.floor(i / 2) * 22})">
       <rect x="0" y="-8" width="10" height="10" rx="2" fill="${f[2]}"/>
       <text x="18" y="1" class="fu-l">${f[0]} &#183; ${f[1]}%</text>
     </g>`).join('');
  return figure({
    svg: svgOpen(360, 176, 'Giving split between funds: general 62%, building 24%, missions 9%, ' +
      'benevolence 5%, with the designated funds kept separate from the general one.') + `
    <style>
      .fu-l{font:400 10px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
      .fu-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
      .fu-n{font:600 10.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
    </style>
    <text x="30" y="30" class="fu-k">WHERE THE GIVING WENT</text>
    <text x="30" y="50" class="fu-n">&#8358;14,280,000 this quarter</text>
    ${rows}
    ${legend}
    <text x="30" y="160" class="fu-l">The building fund cannot quietly pay a light bill.</text>
  </svg>`,
    caption: 'Funds, kept apart. Illustration.'
  });
};

// ------------------------------------------------------ where the data is
const dataArt = () => figure({
  svg: svgOpen(360, 212, 'A diagram: a business in Nigeria connects over an encrypted link to ' +
    'the servers in the United Kingdom, which hold the books and take a nightly backup.') + `
  <style>
    .dm-l{font:400 10.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
    .dm-t{font:600 11.5px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--ink)}
    .dm-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
  </style>
  ${sheet(10, 40, 128, 84)}
  <text x="26" y="66" class="dm-t">Your office</text>
  <text x="26" y="84" class="dm-l">Nigeria</text>
  <text x="26" y="102" class="dm-l">A browser</text>

  <path d="M146 82H214" stroke="var(--gold)" stroke-width="2" stroke-dasharray="5 5" class="flow"/>
  <text x="180" y="72" class="dm-k" text-anchor="middle">HTTPS</text>

  ${sheet(222, 40, 128, 84)}
  <text x="238" y="66" class="dm-t">The server</text>
  <text x="238" y="84" class="dm-l">United Kingdom</text>
  <text x="238" y="102" class="dm-l">Your books</text>

  <path d="M286 132V158" stroke="var(--line)" stroke-width="2"/>
  ${sheet(222, 158, 128, 44)}
  <text x="238" y="184" class="dm-l">Nightly backup, 14 kept</text>

  ${sheet(10, 158, 128, 44)}
  <text x="26" y="178" class="dm-l">Roles decide who</text>
  <text x="26" y="194" class="dm-l">sees which figure</text>
</svg>`,
  caption: 'Where your books live, and what moves between you and them.'
});

// --------------------------------------------------------- how it works
const steps = (title, intro, items, band) => `
<section${band ? ' class="band"' : ''}><div class="wrap">
  <h2>${esc(title)}</h2>
  ${intro ? '<p class="lede" style="margin-bottom:30px">' + intro + '</p>' : ''}
  <ol class="steps">
    ${items.map((it, i) => `<li class="step reveal" style="animation-delay:${i * 80}ms">
      <span class="ico">${icon(it[2])}</span>
      <span class="ord">${String(i + 1).padStart(2, '0')}</span>
      <h3>${esc(it[0])}</h3><p>${it[1]}</p></li>`).join('')}
  </ol>
</div></section>`;

// A figure beside a column of words. The order flips on alternate rows so a
// page of them does not read like a form.
const split = ({ eyebrow, title, paras, art, flip, band }) => `
<section${band ? ' class="band"' : ''}><div class="wrap">
  <div class="split${flip ? ' flip' : ''}">
    <div class="words">
      ${eyebrow ? '<p class="eyebrow">' + esc(eyebrow) + '</p>' : ''}
      <h2>${esc(title)}</h2>
      ${paras.map((t) => '<p>' + t + '</p>').join('')}
    </div>
    ${art}
  </div>
</div></section>`;

// --------------------------------------------- what a seat actually costs
//
// The page already states the price; this works it out for the number of
// people you have. Without JavaScript it is a table of the same figures,
// which is also what a crawler reads.
const seatCalculator = (maxSeats) => {
  const rows = [1, 3, 5, 10, 25].filter((n) => n <= maxSeats).map((n) => `
    <tr><th scope="row">${n} ${n === 1 ? 'person' : 'people'}</th>
      <td>${naira(pricing.PER_USER_MONTHLY * n)}<span class="per"> a month</span></td>
      <td>${naira(pricing.PER_USER_ANNUAL * n)}<span class="per"> a year</span></td></tr>`).join('');
  return `
<section><div class="wrap">
  <h2>What it comes to</h2>
  <p class="lede" style="margin-bottom:26px">Move the slider to the number of people who will
  have a sign-in. Nothing is hidden behind a bigger plan.</p>
  <div class="calc card" id="calc" hidden>
    <div class="calc-head">
      <label for="seats">People with a sign-in</label>
      <output id="seatsOut" for="seats">4 people</output>
    </div>
    <input type="range" id="seats" min="1" max="${maxSeats}" value="4" step="1">
    <div class="calc-grid">
      <div><p class="eyebrow">Monthly</p><p class="amt" id="calcMonthly">${naira(pricing.PER_USER_MONTHLY * 4)}</p><p class="note">billed every month</p></div>
      <div><p class="eyebrow">Yearly</p><p class="amt" id="calcAnnual">${naira(pricing.PER_USER_ANNUAL * 4)}</p><p class="note" id="calcSaving">saves ${naira((pricing.PER_USER_MONTHLY * 12 - pricing.PER_USER_ANNUAL) * 4)} a year</p></div>
    </div>
  </div>
  <p class="note" style="margin-top:14px">Up to ${maxSeats} people on one set of books.
  Seats can go up whenever you like, and down to the number actually using it.</p>
  <table class="bars calc-table" id="calcTable">
    <caption>${naira(pricing.PER_USER_MONTHLY)} per person per month, or ${naira(pricing.PER_USER_ANNUAL)} per person per year.</caption>
    <thead><tr><th scope="col">Team</th><th scope="col">Monthly</th><th scope="col">Yearly</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
  (function(){
    var box=document.getElementById('calc'),r=document.getElementById('seats');
    if(!box||!r||!('oninput' in r))return;
    var m=${pricing.PER_USER_MONTHLY},y=${pricing.PER_USER_ANNUAL};
    var out=document.getElementById('seatsOut'),mo=document.getElementById('calcMonthly'),
        an=document.getElementById('calcAnnual'),sv=document.getElementById('calcSaving'),
        tbl=document.getElementById('calcTable');
    function naira(n){return '\\u20a6'+n.toLocaleString('en-NG');}
    function paint(){var n=+r.value;out.textContent=n+(n===1?' person':' people');
      mo.textContent=naira(m*n);an.textContent=naira(y*n);
      sv.textContent='saves '+naira((m*12-y)*n)+' a year';}
    box.hidden=false;tbl.hidden=true;r.addEventListener('input',paint);paint();
  })();
  </script>
</div></section>`;
};

// ------------------------------------------------------------ the mark
//
// The wordmark, drawn rather than photographed, so it is sharp at any size,
// takes the page's own ink in either theme, and the line finishes itself.
const markArt = () => figure({
  svg: svgOpen(360, 128, 'The Profitna wordmark: PROFIT in the page’s ink, NA in gold, and a ' +
    'rising chart line.') + `
  <rect x="0" y="0" width="360" height="128" rx="14" fill="${BRAND_INK}"/>
  <text x="32" y="76" style="font:700 44px 'Familjen Grotesk',system-ui,sans-serif;letter-spacing:-0.02em" fill="${BRAND_CREAM}">PROFIT<tspan fill="${BRAND_GOLD}">NA</tspan></text>
  <path d="M286 86 L306 62 L318 74 L340 44" fill="none" stroke="${BRAND_GOLD}" stroke-width="7"
        stroke-linecap="round" stroke-linejoin="round" class="draw" style="--len:120"/>
  <text x="32" y="104" style="font:500 11px 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.18em" fill="${BRAND_FAINT}">KNOW YOUR NUMBERS</text>
</svg>`
});

// ----------------------------------------------------- guides, as cards
//
// Each thumbnail is the shape of the thing it explains: the bands, the split
// pension is actually taken on, two taxes side by side, a balance, a run of
// numbers, two months that disagree.
const THUMBS = {
  bands: '<rect x="12" y="52" width="44" height="10" rx="5" fill="var(--c1)"/>' +
    '<rect x="12" y="38" width="68" height="10" rx="5" fill="var(--c2)"/>' +
    '<rect x="12" y="24" width="92" height="10" rx="5" fill="var(--c4)"/>' +
    '<rect x="12" y="10" width="116" height="10" rx="5" fill="var(--c5)"/>',
  split: '<rect x="12" y="14" width="116" height="16" rx="4" fill="var(--line-2)"/>' +
    '<rect x="12" y="38" width="74" height="16" rx="4" fill="var(--c3)"/>' +
    '<path d="M90 46h38" stroke="var(--gold)" stroke-width="2" stroke-dasharray="3 3"/>',
  twotax: '<rect x="12" y="16" width="52" height="40" rx="6" fill="var(--c2)"/>' +
    '<rect x="76" y="16" width="52" height="40" rx="6" fill="var(--c4)"/>' +
    '<path d="M70 20v32" stroke="var(--line)" stroke-width="2"/>',
  balance: '<path d="M70 12v44M40 28h60" stroke="var(--line)" stroke-width="2"/>' +
    '<rect x="22" y="30" width="36" height="20" rx="4" fill="var(--c3)"/>' +
    '<rect x="82" y="30" width="36" height="20" rx="4" fill="var(--c3)"/>',
  numbers: '<rect x="12" y="14" width="116" height="9" rx="4.5" fill="var(--line-2)"/>' +
    '<rect x="12" y="29" width="116" height="9" rx="4.5" fill="var(--line-2)"/>' +
    '<rect x="12" y="44" width="70" height="9" rx="4.5" fill="var(--c5)"/>',
  timing: '<path d="M12 50 L44 50 L44 26 L84 26 L84 50 L128 50" fill="none" stroke="var(--c4)" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M12 36 L52 36 L52 14 L96 14 L96 36 L128 36" fill="none" stroke="var(--c2)" stroke-width="3" stroke-linejoin="round" stroke-dasharray="4 4"/>'
};

const guides = (title, intro, items, band) => `
<section${band ? ' class="band"' : ''}><div class="wrap">
  <h2>${esc(title)}</h2>
  ${intro ? '<p class="lede" style="margin-bottom:28px">' + intro + '</p>' : ''}
  <div class="grid g3">
    ${items.map((it, i) => `<article class="card guide reveal" style="animation-delay:${i * 70}ms">
      <div class="thumb" aria-hidden="true">
        <svg viewBox="0 0 140 68" width="140" height="68" focusable="false">${THUMBS[it[2]] || ''}</svg>
      </div>
      <h3>${esc(it[0])}</h3><p>${it[1]}</p>
    </article>`).join('')}
  </div>
</div></section>`;

// ------------------------------------------- twelve payments, or one
//
// The only comparison on the pricing page, and both numbers are read from
// src/pricing.js rather than typed, so the picture cannot promise a saving
// the paywall does not give.
const priceArt = () => {
  const monthlyYear = pricing.PER_USER_MONTHLY * 12;
  const annual = pricing.PER_USER_ANNUAL;
  const saving = monthlyYear - annual;
  const w = (v) => Math.round((v / monthlyYear) * 236);
  return figure({
    svg: svgOpen(360, 168, 'A comparison of a year of monthly payments at ' +
      monthlyYear.toLocaleString('en-NG') + ' naira a seat against one yearly payment at ' +
      annual.toLocaleString('en-NG') + ', a saving of ' + saving.toLocaleString('en-NG') +
      ' naira per person.') + `
    <style>
      .pr-l{font:500 11px 'Familjen Grotesk',system-ui,sans-serif;fill:var(--muted)}
      .pr-n{font:600 11.5px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--ink)}
      .pr-k{font:600 9px 'IBM Plex Mono',ui-monospace,monospace;fill:var(--gold);letter-spacing:.12em}
    </style>
    <text x="22" y="26" class="pr-k">ONE SEAT, ONE YEAR</text>
    <text x="22" y="58" class="pr-l">Twelve monthly payments</text>
    <rect x="22" y="66" width="${w(monthlyYear)}" height="16" rx="4" fill="var(--c2)" class="grow-x"/>
    <text x="${22 + w(monthlyYear) + 10}" y="79" class="pr-n">${naira(monthlyYear)}</text>
    <text x="22" y="110" class="pr-l">Paid once a year</text>
    <rect x="22" y="118" width="${w(annual)}" height="16" rx="4" fill="var(--c4)" class="grow-x" style="animation-delay:120ms"/>
    <text x="${22 + w(annual) + 10}" y="131" class="pr-n">${naira(annual)}</text>
    <g transform="translate(22 142)">
      <rect x="0" y="0" width="150" height="20" rx="10" fill="color-mix(in srgb,var(--gold) 16%,var(--card))"/>
      <text x="12" y="14" class="pr-l">You keep ${naira(saving)} a seat</text>
    </g>
  </svg>`,
    caption: 'The yearly price is the monthly one with a month taken off.'
  });
};

module.exports = {
  icon, ICONS, heroArt, chips, paye, figure,
  invoiceArt, payslipArt, ledgerArt, ageingArt, fundsArt, dataArt,
  steps, split, seatCalculator, markArt, guides, THUMBS, priceArt
};
