// The public pages, rendered on the server.
//
// Why these are not part of the application:
//
// Profitna itself is one 500 KB file that a browser compiles at runtime. That
// is a reasonable trade for a tool somebody signs into every morning, and a
// terrible one for a page a stranger lands on from a search result. A crawler
// reading that file finds four hundred unrendered template placeholders and
// eight competing <h1>s, because it is reading template source rather than a
// page.
//
// So the marketing pages are plain HTML, built here and sent complete. No
// framework, no build step, no JavaScript required to read a word of them.
// They share the product's type, palette and restraint — the privacy notice
// proved the pattern — so the two halves look like one company without the
// marketing half inheriting the application's weight.

const PRODUCT = 'Profitna';
const COMPANY = 'Mideops Professional Services Ltd';
const SUPPORT = 'support@profitna.com';

// Every absolute URL on these pages comes from here, so a canonical, a
// sitemap entry and an Open Graph tag cannot disagree about the site's own
// address.
function origin() {
  const raw = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || 'https://profitna.com';
  return String(raw).replace(/\/+$/, '');
}

const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ----------------------------------------------------------------- styling

// One stylesheet, inlined. A separate request for 6 KB of CSS costs a round
// trip on a Nigerian mobile connection and buys nothing.
const CSS = `
:root{
  --paper:#F4F3EE; --card:#FFFFFF; --ink:#1a1a1a; --muted:#5C5850; --faint:#8A8578;
  --line:#E5E1D8; --line-2:#EFEDE7; --gold:#B8863A; --gold-soft:#FAC775; --link:#412402;
  --band:#FBFAF7;
  --c1:#D9A94F; --c2:#C68F35; --c3:#AE7726; --c4:#96601B; --c5:#7A4C12;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#14130F; --card:#1C1B17; --ink:#EDEAE2; --muted:#A9A49A; --faint:#6E6A61;
    --line:#2C2A24; --line-2:#24231E; --gold:#D2A45C; --gold-soft:#8A6A2A; --link:#E0B877;
    --band:#1A1915;
    --c1:#8A6A2A; --c2:#A5803A; --c3:#BE9449; --c4:#D2A45C; --c5:#E3BC7D;
  }
}
:root[data-theme="dark"]{
  --paper:#14130F; --card:#1C1B17; --ink:#EDEAE2; --muted:#A9A49A; --faint:#6E6A61;
  --line:#2C2A24; --line-2:#24231E; --gold:#D2A45C; --gold-soft:#8A6A2A; --link:#E0B877;
  --band:#1A1915;
  --c1:#8A6A2A; --c2:#A5803A; --c3:#BE9449; --c4:#D2A45C; --c5:#E3BC7D;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font:16px/1.65 'Familjen Grotesk',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1060px;margin:0 auto;padding:0 20px}
.narrow{max-width:760px}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
a:hover{color:var(--gold)}
h1,h2,h3{line-height:1.2;letter-spacing:-0.015em;margin:0}
h1{font-size:clamp(32px,5.2vw,52px);font-weight:700}
h2{font-size:clamp(23px,3vw,32px);font-weight:600;margin:0 0 12px}
h3{font-size:18px;font-weight:600;margin:0 0 6px}
p{margin:0 0 16px;color:var(--muted)}
.lede{font-size:clamp(17px,2.1vw,20px);color:var(--ink);opacity:.86;max-width:60ch}
.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-weight:600;margin:0 0 14px}

header.site{border-bottom:1px solid var(--line);position:sticky;top:0;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(8px);z-index:20}
header.site .bar{display:flex;align-items:center;gap:18px;height:64px}
.brand{font-weight:700;letter-spacing:-0.02em;font-size:18px;text-decoration:none;color:var(--ink);white-space:nowrap}
.brand b{color:var(--gold)}
nav.main{display:flex;gap:18px;margin-left:auto;align-items:center;flex-wrap:wrap}
nav.main a{font-size:14.5px;text-decoration:none;color:var(--muted)}
nav.main a:hover,nav.main a[aria-current]{color:var(--ink)}
.btn{display:inline-block;border-radius:8px;padding:11px 20px;font-size:14.5px;font-weight:600;text-decoration:none;border:1px solid transparent;white-space:nowrap}
.btn.primary{background:var(--ink);color:var(--paper)}
.btn.primary:hover{background:var(--gold-soft);color:#412402}
.btn.ghost{border-color:var(--line);color:var(--ink);background:var(--card)}
.btn.ghost:hover{border-color:var(--gold);color:var(--ink)}
.btn.sm{padding:8px 15px;font-size:13.5px}

section{padding:62px 0;border-bottom:1px solid var(--line-2)}
section.hero{padding:76px 0 62px;border-bottom:1px solid var(--line)}
section.band{background:var(--band)}
.grid{display:grid;gap:18px}
.g2{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(248px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
.card p:last-child{margin-bottom:0}
.card .num{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px;color:var(--gold);display:block;margin-bottom:10px}

.price{display:flex;align-items:baseline;gap:8px;margin:4px 0 6px}
.price .amt{font-size:40px;font-weight:700;letter-spacing:-0.02em}
.price .per{font-size:14px;color:var(--faint)}
.tick{list-style:none;padding:0;margin:0}
.tick li{padding:8px 0 8px 26px;position:relative;color:var(--muted);border-bottom:1px solid var(--line-2)}
.tick li:last-child{border-bottom:0}
.tick li::before{content:"";position:absolute;left:4px;top:16px;width:9px;height:5px;border-left:2px solid var(--gold);border-bottom:2px solid var(--gold);transform:rotate(-45deg)}
.note{font-size:13.5px;color:var(--faint)}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:26px;align-items:center}
dl.faq{margin:0}
dl.faq dt{font-weight:600;margin:22px 0 6px;color:var(--ink)}
dl.faq dd{margin:0;color:var(--muted)}
footer.site{padding:44px 0 56px;color:var(--faint);font-size:14px}
footer.site .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:26px;margin-bottom:28px}
footer.site h3{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
footer.site a{display:block;color:var(--faint);text-decoration:none;padding:4px 0}
footer.site a:hover{color:var(--ink)}
footer.site .fine{border-top:1px solid var(--line);padding-top:20px;line-height:1.7}
@media (max-width:760px){
  section{padding:44px 0}
  section.hero{padding:52px 0 44px}
  nav.main{display:none}
  header.site .bar{gap:10px}
}
/* ---------------------------------------------------- homepage figures */
/* Everything here draws with CSS and inline SVG. No images, no second
   request, nothing that has to load before the page makes sense. */
.hero.split .wrap{display:grid;grid-template-columns:1.06fr .94fr;gap:48px;align-items:center}
.hero.split .copy{min-width:0}
figure{margin:0;min-width:0}
figcaption{font-size:12.5px;color:var(--faint);margin-top:11px;line-height:1.5}
.art,.fig{background:var(--card);border:1px solid var(--line);border-radius:14px}
.art{padding:16px}
.fig{padding:26px 24px}
.art svg{display:block;width:100%;height:auto}

.chips{display:flex;flex-wrap:wrap;gap:10px}
.chip{display:inline-flex;align-items:center;gap:9px;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:9px 15px 9px 13px;font-size:13.5px;font-weight:500;color:var(--ink)}
.chip svg{flex:0 0 auto;display:block}
.card .ico,.step .ico{width:40px;height:40px;border-radius:11px;background:color-mix(in srgb,var(--gold) 14%,var(--card));display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.card .ico svg,.step .ico svg{display:block}

/* The band chart is a real table with the bars drawn in it, so the figures
   are readable by a crawler, by a screen reader and by somebody who just
   wants the number — and there is no second, prettier version of the data
   that could disagree with it. */
table.bars{width:100%;border-collapse:collapse}
table.bars caption{caption-side:top;text-align:left;color:var(--faint);font-size:13px;line-height:1.5;margin-bottom:16px}
table.bars thead th{font-size:11.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);font-weight:600;text-align:left;padding:0 16px 10px 0;border-bottom:1px solid var(--line)}
table.bars tbody th{text-align:left;font-weight:500;font-size:14.5px;color:var(--ink);white-space:nowrap;padding:10px 16px 10px 0}
table.bars tbody td{padding:10px 0;width:100%}
table.bars tbody tr+tr th,table.bars tbody tr+tr td{border-top:1px solid var(--line-2)}
.track{display:inline-block;vertical-align:middle;width:calc(100% - 50px);height:14px;background:var(--line-2);border-radius:3px}
.bar{display:block;height:14px;border-radius:3px 4px 4px 3px;min-width:3px}
.rate{display:inline-block;width:46px;text-align:right;vertical-align:middle;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;font-size:14.5px}

@media (max-width:860px){
  .hero.split .wrap{grid-template-columns:1fr;gap:34px}
}
@media (max-width:620px){
  table.bars thead{display:none}
  table.bars tbody tr{display:block;padding:12px 0}
  table.bars tbody th,table.bars tbody td{display:block;width:100%;padding:0;white-space:normal}
  table.bars tbody th{padding-bottom:7px}
  table.bars tbody tr+tr th{border-top:0}
  table.bars tbody tr+tr{border-top:1px solid var(--line-2)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.trim();

// ------------------------------------------------------------------- chrome

// Four links. Security and About are real pages and stay linked from the
// footer and the sitemap, but they are not what somebody landing here needs
// to decide anything, so they are not in the top bar.
const NAV = [
  ['/features', 'Features'],
  ['/pricing', 'Pricing'],
  ['/resources', 'Resources']
];

function header(path) {
  const links = NAV.map(([href, label]) =>
    '<a href="' + href + '"' + (href === path ? ' aria-current="page"' : '') + '>' + label + '</a>'
  ).join('');
  return `<header class="site"><div class="wrap bar">
  <a class="brand" href="/">PROFIT<b>NA</b></a>
  <nav class="main" aria-label="Main">${links}</nav>
  <a class="btn ghost sm" href="/app">Sign in</a>
  <a class="btn primary sm" href="/app?start=1">Start free</a>
</div></header>`;
}

function footer() {
  const col = (title, links) => '<div><h3>' + title + '</h3>' +
    links.map(([h, l]) => '<a href="' + h + '">' + l + '</a>').join('') + '</div>';
  return `<footer class="site"><div class="wrap">
  <div class="cols">
    ${col('Product', [['/features', 'Features'], ['/pricing', 'Pricing'], ['/security', 'Security']])}
    ${col('Who it is for', [['/solutions/retail', 'Retail & trading'], ['/solutions/accountants', 'Accountants'], ['/solutions/churches', 'Churches & non-profits']])}
    ${col('Company', [['/about', 'About'], ['/contact', 'Contact'], ['/privacy', 'Privacy & cookies']])}
    ${col('Learn', [['/resources', 'Resources']])}
  </div>
  <div class="fine">
    <strong>${PRODUCT}</strong> is operated by ${COMPANY}, registered in Nigeria.<br>
    Accounting and business finance software for Nigerian businesses, churches and non-profits.<br>
    <a href="mailto:${SUPPORT}">${SUPPORT}</a>
  </div>
</div></footer>`;
}

// --------------------------------------------------------------------- page

// `page` is content; everything a crawler needs is assembled here so no page
// can forget its canonical or ship without a description.
function render(page) {
  const url = origin() + page.path;
  const title = page.title;
  const description = page.description;
  const social = origin() + '/og.png';

  if (!title || !description) {
    throw new Error('marketing: every page needs a title and a description (' + page.path + ')');
  }

  return `<!doctype html>
<html lang="en-NG">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${PRODUCT}">
<meta property="og:locale" content="en_NG">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(social)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(social)}">
<meta name="theme-color" content="#F4F3EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14130F" media="(prefers-color-scheme: dark)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${header(page.path)}
<main>
${page.body}
</main>
${footer()}
</body>
</html>`;
}

module.exports = { render, origin, esc, PRODUCT, COMPANY, SUPPORT, NAV, CSS };
