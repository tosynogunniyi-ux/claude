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
