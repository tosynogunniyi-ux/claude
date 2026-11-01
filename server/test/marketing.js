// The public site, as a crawler and as a customer.
//
//   npm start            (in one shell)
//   npm run test:marketing
//
// Two things are being protected here. One is that the marketing pages are
// actually readable by a machine that does not run JavaScript. The other,
// and the more important, is that putting a public site at `/` did not take
// the application away from the people who were already using it.

require('dotenv').config();
const http = require('http');
const { pool } = require('../src/db');
const { PAGES } = require('../src/marketing/content');
const pricing = require('../src/pricing');

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// Raw http so the Host header can be set: fetch forbids it, and these pages
// build absolute URLs from the host they were asked on.
function get(path, headers) {
  return new Promise((resolve, reject) => {
    const t = new URL(BASE);
    const req = http.request({
      host: t.hostname, port: t.port || 80, path, method: 'GET',
      headers: Object.assign({ Host: 'profitna.com' }, headers || {})
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Roughly what a text-only crawler keeps.
function visible(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const between = (html, re) => (html.match(re) || [])[1] || '';

(async () => {
  console.log('\nevery public page answers');

  const fetched = {};
  for (const page of PAGES) {
    const res = await get(page.path);
    fetched[page.path] = res;
    check(page.path + ' returns 200', res.status === 200, 'status ' + res.status);
  }

  console.log('\nand is readable without JavaScript');

  for (const page of PAGES) {
    const html = fetched[page.path].body;
    const text = visible(html);
    const h1 = (html.match(/<h1[^>]*>/gi) || []).length;

    check(page.path + ' has exactly one h1', h1 === 1, String(h1) + ' found');
    check(page.path + ' has no unrendered template placeholders',
      !text.includes('{{'), text.slice(0, 80));
    check(page.path + ' carries real prose', text.length > 900, text.length + ' chars');
  }

  console.log('\nwith the head a search engine needs');

  for (const page of PAGES) {
    const html = fetched[page.path].body;
    const canonical = between(html, /<link rel="canonical" href="([^"]+)"/);
    const description = between(html, /<meta name="description" content="([^"]+)"/);
    const title = between(html, /<title>([^<]+)<\/title>/);
    const expect = 'https://profitna.com' + (page.path === '/' ? '' : page.path);

    check(page.path + ' canonical points at itself',
      canonical === expect || canonical === expect + '/', canonical);
    check(page.path + ' has a description of a useful length',
      description.length >= 70 && description.length <= 320, String(description.length));
    check(page.path + ' has a title under 70 characters', title.length > 0 && title.length <= 70,
      title.length + ': ' + title);
    check(page.path + ' is not accidentally noindexed',
      /<meta name="robots" content="index,follow/.test(html));
    check(page.path + ' can be shared', /og:title/.test(html) && /og:image/.test(html));
  }

  // Two titles that read the same in a result list are two pages competing.
  const titles = PAGES.map((p) => between(fetched[p.path].body, /<title>([^<]+)<\/title>/));
  check('every title is distinct', new Set(titles).size === titles.length);
  const descs = PAGES.map((p) => between(fetched[p.path].body, /<meta name="description" content="([^"]+)"/));
  check('every description is distinct', new Set(descs).size === descs.length);

  console.log('\nthe pricing shown is the pricing charged');

  const priceHtml = fetched['/pricing'].body;
  check('the monthly rate comes from pricing.js',
    priceHtml.includes('₦' + pricing.PER_USER_MONTHLY.toLocaleString('en-NG')),
    '₦' + pricing.PER_USER_MONTHLY);
  check('so does the annual rate',
    priceHtml.includes('₦' + pricing.PER_USER_ANNUAL.toLocaleString('en-NG')));
  check('and the trial length', priceHtml.includes(String(pricing.TRIAL_DAYS) + '-day') ||
    priceHtml.includes(String(pricing.TRIAL_DAYS) + ' days'));

  console.log('\nrobots and sitemap agree with reality');

  const robots = await get('/robots.txt');
  check('robots.txt is served as text', robots.status === 200 &&
    /text\/plain/.test(robots.headers['content-type']));
  check('it points at the sitemap', /Sitemap: https:\/\/profitna\.com\/sitemap\.xml/.test(robots.body));
  check('it keeps crawlers out of the application', /Disallow: \/app/.test(robots.body));
  check('and out of the API', /Disallow: \/api\//.test(robots.body));
  check('and out of the owner console', /Disallow: \/admin/.test(robots.body));
  for (const bot of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot']) {
    check('  ' + bot + ' is named', robots.body.includes('User-agent: ' + bot));
  }

  const sitemap = await get('/sitemap.xml');
  check('sitemap.xml is served as XML', sitemap.status === 200 &&
    /xml/.test(sitemap.headers['content-type']));
  const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('it lists every public page', locs.length === PAGES.length,
    locs.length + ' of ' + PAGES.length);
  check('every url in it is absolute and https',
    locs.every((l) => l.startsWith('https://profitna.com')), locs[0]);
  // A sitemap entry for a page asking not to be indexed is a contradiction a
  // crawler reports back to you.
  check('it does not list the privacy notice, which is noindex',
    !locs.some((l) => /\/privacy|\/cookies/.test(l)));

  for (const loc of locs) {
    const path = loc.replace('https://profitna.com', '') || '/';
    const res = await get(path);
    check('  ' + path + ' in the sitemap actually answers 200', res.status === 200,
      'status ' + res.status);
  }

  console.log('\nand every page says what it is, in a form a machine reads');

  const ld = {};
  for (const page of PAGES) {
    const html = fetched[page.path].body;
    const raw = between(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let data = null;
    try { data = JSON.parse(raw.replace(/\\u003c/g, '<')); } catch (e) { data = null; }
    ld[page.path] = data;
    check(page.path + ' carries structured data that parses', Boolean(data),
      raw ? raw.slice(0, 60) : 'none found');
  }

  const typesOn = (path) => (ld[path] ? ld[path]['@graph'].map((n) => n['@type']) : []);

  check('it is a schema.org graph',
    PAGES.every((p) => ld[p.path] && ld[p.path]['@context'] === 'https://schema.org'));
  check('every page names the company behind it',
    PAGES.every((p) => typesOn(p.path).includes('Organization')));
  check('and the site it belongs to',
    PAGES.every((p) => typesOn(p.path).includes('WebSite')));
  check('every page but the home page has a breadcrumb',
    PAGES.every((p) => p.path === '/' || typesOn(p.path).includes('BreadcrumbList')));
  check('the home page describes the product',
    typesOn('/').includes('SoftwareApplication'));
  check('so do features and pricing',
    typesOn('/features').includes('SoftwareApplication') &&
    typesOn('/pricing').includes('SoftwareApplication'));

  const org = ld['/']['@graph'].find((n) => n['@type'] === 'Organization');
  check('the organisation is the one that actually operates it',
    org.legalName === 'Mideops Professional Services Ltd', org.legalName);
  check('and points at a logo that exists', Boolean(org.logo && org.logo.url));
  const logo = await get('/logo.png');
  check('  which answers 200 as an image', logo.status === 200 &&
    /image\/png/.test(logo.headers['content-type'] || ''), 'status ' + logo.status);

  // The markup must not be able to say a different price from the paywall.
  const software = ld['/pricing']['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
  const prices = software.offers.map((o) => o.price);
  check('the marked-up monthly price is the one charged',
    prices.includes(String(pricing.PER_USER_MONTHLY)), prices.join(', '));
  check('and so is the annual one',
    prices.includes(String(pricing.PER_USER_ANNUAL)), prices.join(', '));
  check('priced in naira', software.offers.every((o) => o.priceCurrency === 'NGN'));

  // Marked-up answers a visitor cannot see are what gets a site's rich
  // results removed.
  for (const path of ['/', '/pricing']) {
    const faqNode = ld[path]['@graph'].find((n) => n['@type'] === 'FAQPage');
    check(path + ' marks up its questions', Boolean(faqNode));
    const visibleText = visible(fetched[path].body);
    const everyQuestionShown = faqNode.mainEntity.every((q) => visibleText.includes(q.name));
    check('  and every one of them is on the page', everyQuestionShown,
      (faqNode.mainEntity.find((q) => !visibleText.includes(q.name)) || {}).name);
    const everyAnswerShown = faqNode.mainEntity.every((q) =>
      visibleText.includes(q.acceptedAnswer.text.slice(0, 40)));
    check('  as is every answer', everyAnswerShown);
  }

  // Nothing invented. These are the claims a search engine penalises hardest
  // and the ones there is no evidence for.
  const everyNode = PAGES.flatMap((p) => (ld[p.path] ? ld[p.path]['@graph'] : []));
  check('nothing claims a rating', !everyNode.some((n) => n.aggregateRating || n.review));
  check('nothing claims an award', !everyNode.some((n) => n.award || n.awards));

  console.log('\nmeasurement is off until it is configured, and consented after');

  const offHtml = fetched['/'].body;
  check('no analytics is loaded with no measurement id set',
    !/googletagmanager/.test(offHtml));
  check('and no consent bar is shown, because there is nothing to consent to',
    !/id="consent"/.test(offHtml));

  // The configured states, without restarting the server under the test.
  const { execFileSync } = require('child_process');
  const renderWith = (env) => execFileSync(process.execPath, ['-e', `
    const { PAGES } = require('./src/marketing/content');
    const { render } = require('./src/marketing/render');
    const a = require('./src/marketing/analytics');
    const html = render(PAGES[0]);
    process.stdout.write(JSON.stringify({
      state: a.describe().state,
      warnings: a.describe().warnings.length,
      tag: /googletagmanager\\.com\\/gtag\\/js\\?id=/.test(html),
      denied: /ad_storage:'denied'/.test(html) && /analytics_storage:'denied'/.test(html),
      bar: /id="consent"/.test(html),
      google: /google-site-verification/.test(html),
      bing: /msvalidate\\.01/.test(html),
      inApp: /googletagmanager/.test(require('fs').readFileSync('../web/Profitna.dc.html', 'utf8'))
    }));
  `], { cwd: __dirname + '/..', env: Object.assign({}, process.env, env) }).toString();

  const on = JSON.parse(renderWith({
    GA4_MEASUREMENT_ID: 'G-TEST1234AB',
    GOOGLE_SITE_VERIFICATION: 'google-token-for-the-test',
    BING_SITE_VERIFICATION: 'bing-token-for-the-test'
  }));
  check('a measurement id turns it on', on.state === 'on' && on.tag, JSON.stringify(on));
  check('every storage consent starts denied', on.denied);
  check('and the visitor is asked', on.bar);
  check('Search Console and Bing can both be claimed', on.google && on.bing);
  check('the application itself is never measured', !on.inApp);

  const typo = JSON.parse(renderWith({ GA4_MEASUREMENT_ID: 'GTM-ABC123' }));
  check('a tag id in the wrong field is refused, not loaded',
    typo.state === 'misconfigured' && !typo.tag, JSON.stringify(typo));
  check('and the reason is reported', typo.warnings > 0);

  console.log('\nthe homepage leads with the product');

  const homeHtml = fetched['/'].body;
  const nav = between(homeHtml, /<nav class="main"[^>]*>([\s\S]*?)<\/nav>/);
  const foot = between(homeHtml, /<footer class="site">([\s\S]*?)<\/footer>/);

  check('Security is not in the top navigation', !/href="\/security"/.test(nav), nav);
  check('About is not in the top navigation', !/href="\/about"/.test(nav), nav);
  // Off the top bar is not the same as gone: a page nothing links to is a page
  // a crawler eventually drops.
  check('Security is still linked from the footer', /href="\/security"/.test(foot));
  check('About is still linked from the footer', /href="\/about"/.test(foot));
  check('and both are still in the sitemap',
    locs.includes('https://profitna.com/security') && locs.includes('https://profitna.com/about'));

  console.log('\nand its pictures are drawn, not fetched');

  // The rule is not "no images" — the hero carries one photograph, because a
  // page about a person's working day should show one. The rule is that a
  // picture behaves: it declares its size so nothing jumps when it lands, it
  // says what it shows, and it is small enough to arrive on a phone.
  const imgs = [...homeHtml.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  check('the homepage carries at most one photograph', imgs.length <= 1,
    String(imgs.length));
  for (const tag of imgs) {
    check('  it declares its width and height', /width="\d+"/.test(tag) && /height="\d+"/.test(tag), tag.slice(0, 80));
    check('  it says what it shows', /alt="[^"]{20,}"/.test(tag), tag.slice(0, 80));
    check('  and it is asked for early, not lazily', /fetchpriority="high"/.test(tag));
  }
  const photo = await get('/img/hero.webp');
  check('the photograph is served', photo.status === 200 &&
    /image\/webp/.test(photo.headers['content-type'] || ''), 'status ' + photo.status);
  check('  and is small enough for a phone',
    Number(photo.headers['content-length'] || 0) < 120000,
    photo.headers['content-length'] + ' bytes');
  check('  and is cached for a long time',
    /max-age=\d{6,}/.test(photo.headers['cache-control'] || ''), photo.headers['cache-control']);
  check('it carries inline figures', (homeHtml.match(/<svg\b/g) || []).length >= 8,
    String((homeHtml.match(/<svg\b/g) || []).length));
  // Every page should have something to look at, not just the home page.
  for (const page of PAGES) {
    const svgs = (fetched[page.path].body.match(/<svg\b/g) || []).length;
    check('  ' + page.path + ' has something drawn on it', svgs >= 2, String(svgs));
  }
  // Everything else stays drawn. One photograph on the whole site, on the one
  // page where it earns the request.
  const withPhotos = PAGES.filter((p) => /<img\b/i.test(fetched[p.path].body)).map((p) => p.path);
  check('and the rest of the site is drawn, not photographed',
    withPhotos.length <= 1 && (withPhotos.length === 0 || withPhotos[0] === '/'),
    withPhotos.join(', '));
  check('every figure says what it is',
    !/<svg\b(?![^>]*(aria-hidden|aria-label|role="img"))/i.test(homeHtml));
  // What a visitor on a Nigerian mobile connection actually waits for is the
  // compressed page, so that is what is measured. The uncompressed ceiling is
  // there too, because a page that needs gzip to be sane is a page with a
  // problem gzip is hiding.
  const zlib = require('zlib');
  for (const page of PAGES) {
    const raw = Buffer.byteLength(fetched[page.path].body);
    const sent = zlib.gzipSync(fetched[page.path].body).length;
    check('  ' + page.path + ' stays small on the wire', sent < 20000, sent + ' bytes gzipped');
    check('  ' + page.path + ' stays reasonable uncompressed', raw < 60000, raw + ' bytes');
  }

  // The tax picture is drawn from the payroll engine's own frozen rules. If
  // somebody edits a band, this fails until the picture agrees again.
  const statutory = require('../src/payroll/statutory');
  const inForce = statutory.rulesFor(new Date().toISOString().slice(0, 10));
  check('the band figure names the rules it is drawn from',
    homeHtml.includes(inForce.label), inForce.label);
  for (const band of inForce.bands) {
    const rate = band.rateBp / 100;
    check('  the ' + rate + '% band is shown',
      homeHtml.includes('>' + rate + '%<'));
  }

  console.log('\nthe application is still where its users left it');

  const app = await get('/app');
  check('/app serves the application', app.status === 200 && app.body.includes('<x-dc>'));

  // The link that matters most: every invitation already sent points at `/`
  // with a token on it, and those must keep opening the application.
  const invite = await get('/?invite=some-token');
  check('a /?invite= link still opens the application', invite.body.includes('<x-dc>'));

  const anonymous = await get('/');
  check('a stranger at / gets the marketing page instead',
    !anonymous.body.includes('<x-dc>') && anonymous.body.includes('Know your numbers'));

  // A signed-in person must see no change at all.
  const stamp = Date.now();
  const email = 'mkt-' + stamp + '@mideops.ng';
  const signup = await new Promise((resolve, reject) => {
    const t = new URL(BASE);
    const payload = JSON.stringify({
      name: 'Marketing Test', org: 'Marketing Co ' + stamp, email,
      password: 'marketing-test-pass-1', book: 'sme', cycle: 'monthly', users: 1
    });
    const req = http.request({
      host: t.hostname, port: t.port || 80, path: '/api/auth/signup', method: 'POST',
      headers: { Host: 'profitna.com', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.resume(); res.on('end', () => resolve(res.headers['set-cookie'] || [])); });
    req.on('error', reject);
    req.end(payload);
  });
  const cookie = (signup[0] || '').split(';')[0];
  check('a new account signs in', Boolean(cookie), JSON.stringify(signup).slice(0, 60));

  const signedIn = await get('/', { Cookie: cookie });
  check('a signed-in person at / still gets the application',
    signedIn.body.includes('<x-dc>'), signedIn.body.slice(0, 60));

  console.log('\nand nothing private became crawlable');

  for (const page of PAGES) {
    const text = visible(fetched[page.path].body);
    check('  ' + page.path + ' leaks no account data',
      !/@mideops\.ng/.test(text) && !/\b\d{10}\b/.test(text));
  }
  const apiProbe = await get('/api/orgs/00000000-0000-0000-0000-000000000000/data');
  check('the books are still behind authentication', apiProbe.status === 401,
    'status ' + apiProbe.status);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  await pool.query("DELETE FROM organizations WHERE name = $1", ['Marketing Co ' + stamp]);
  await pool.end();

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nmarketing test could not finish:', err.message);
  console.error(err.stack);
  process.exit(1);
});
