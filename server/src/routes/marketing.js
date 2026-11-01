// The public site: the pages a stranger can find, plus the two files that
// tell a crawler what to do with them.
//
// THE ONE DECISION WORTH REVIEWING IS WHAT HAPPENS AT `/`.
//
// Before this, `/` was the application — a 500 KB file a browser compiles at
// runtime. That is the right thing to serve somebody who signs in every
// morning and the wrong thing to serve a search engine, so `/` now answers
// with the marketing page instead, and the application moved to `/app`.
//
// The rule is deliberately narrow, because `/` is the most load-bearing URL
// in the product and existing links through it must not break:
//
//   `/` with a session cookie            -> the application, as before.
//   `/` with any query string            -> the application, as before. This
//                                           is what keeps /?invite=TOKEN and
//                                           every link already sent working.
//   `/` otherwise (and every crawler)    -> the marketing page.
//   `/app`                               -> the application, always.
//
// A signed-in person therefore sees no change at all. A signed-out one who
// bookmarked `/` lands on the marketing page with Sign in at the top right,
// which is a worse outcome by one click and a better one for everybody
// arriving from a search result. It is reversible by deleting this file's
// handler for `/`.

const express = require('express');
const path = require('path');
const { render, origin } = require('../marketing/render');
const { PAGES, BY_PATH } = require('../marketing/content');
const { COOKIE } = require('../auth');

const router = express.Router();

// Rendered once per process rather than per request. The content is static
// and the pages are a few kilobytes each; building them on every hit would
// be work done thousands of times for an answer that never changes.
const BUILT = new Map();
function html(page) {
  if (!BUILT.has(page.path)) BUILT.set(page.path, render(page));
  return BUILT.get(page.path);
}

// A day of browser cache, revalidated. Long enough to matter on a slow
// connection, short enough that a correction to a price reaches people.
const CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

function send(res, page) {
  res.set('Cache-Control', CACHE);
  res.type('html').send(html(page));
}

const signedIn = (req) => Boolean(req.cookies && req.cookies[COOKIE]);

// --------------------------------------------------------------- the pages

for (const page of PAGES) {
  if (page.path === '/') continue;          // handled below, with the fork
  router.get(page.path, (req, res) => send(res, page));
}

// `/` — see the note at the top of this file.
function home(appHandler) {
  return (req, res) => {
    const wantsApp = signedIn(req) || Object.keys(req.query || {}).length > 0;
    if (wantsApp) return appHandler(req, res);
    return send(res, BY_PATH.get('/'));
  };
}

// ------------------------------------------------------------- robots.txt

// Deliberately permissive for the public pages and explicit about the rest.
//
// The AI crawlers are named rather than left to the wildcard, because being
// named is how a policy survives somebody later tightening the default — and
// because a reader of this file should be able to see, without guessing, who
// is welcome.
function robots() {
  const base = origin();
  const allowAll = [
    'User-agent: *',
    'Allow: /$',
    ...PAGES.filter((p) => p.path !== '/').map((p) => 'Allow: ' + p.path),
    'Allow: /privacy',
    'Allow: /cookies',
    // The application and everything behind it. None of it is useful to a
    // crawler and some of it is somebody's books.
    'Disallow: /app',
    'Disallow: /api/',
    'Disallow: /admin',
    ''
  ];

  // Named explicitly. Same policy as everyone else today; written down so a
  // change to it is a decision rather than an accident.
  const named = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot',
    'Claude-SearchBot', 'ClaudeBot', 'Google-Extended', 'Applebot']
    .flatMap((ua) => ['User-agent: ' + ua, 'Allow: /', 'Disallow: /app', 'Disallow: /api/',
      'Disallow: /admin', '']);

  return [...allowAll, ...named, 'Sitemap: ' + base + '/sitemap.xml', ''].join('\n');
}

router.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', CACHE);
  res.type('text/plain').send(robots());
});

// -------------------------------------------------------------- sitemap.xml

// Only pages that return 200 and are meant to be indexed. The privacy notice
// is left out on purpose: it carries its own noindex, and listing a page you
// have asked not to be indexed is a contradiction a crawler reports back.
function sitemap() {
  const base = origin();
  const today = new Date().toISOString().slice(0, 10);
  const url = (p) => [
    '  <url>',
    '    <loc>' + base + (p.path === '/' ? '/' : p.path) + '</loc>',
    '    <lastmod>' + today + '</lastmod>',
    '    <changefreq>' + (p.changefreq || 'monthly') + '</changefreq>',
    '    <priority>' + (p.priority || '0.5') + '</priority>',
    '  </url>'
  ].join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    PAGES.map(url).join('\n') + '\n</urlset>\n';
}

router.get('/sitemap.xml', (req, res) => {
  res.set('Cache-Control', CACHE);
  res.type('application/xml').send(sitemap());
});

module.exports = { router, home, robots, sitemap, html, PAGES };
