// Does the ad tracking send the right thing, and never the wrong thing?
//   npm run test:meta
//
// Two things are worth proving here and the second matters more than the
// first. One: that an event reaches Meta in the shape Meta reads, under an id
// that pairs it with the browser's copy so a sale is counted once. Two: that
// an email address never leaves this server in a form anyone can read.
//
// No network and no Meta account needed — the Graph endpoint is a stub, and
// the hashes are checked against SHA-256 computed here, independently of the
// code under test.

const http = require('http');
const crypto = require('crypto');

const meta = require('../src/integrations/meta');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

// --------------------------------------------------------------- the stub

function graph(behaviour) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ url: req.url, headers: req.headers, raw, body: JSON.parse(raw || '{}') });
      if (behaviour && behaviour.fail) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ events_received: 1, messages: [], fbtrace_id: 'A1' }));
    });
  });
  return { server, seen };
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => s.close(r));

function unconfigure() {
  for (const k of Object.keys(process.env)) if (k.startsWith('META_')) delete process.env[k];
}

const EMAIL = 'Tosyn.Ogunniyi@Example.NG ';
const USER_ID = '7a08bd8b-f003-4f25-af01-f9459046d0ea';

(async () => {
  console.log('\nwith nothing configured');
  unconfigure();
  check('no events are sent', (await meta.track({ name: 'Purchase', id: 'x' })) === null);
  check('the browser half is off too', meta.browserConfigured() === false);
  check('and the public config has no pixel to hand out', meta.pixelId() === '');
  check('it says so rather than warning', meta.warnings().length === 0);

  console.log('\nhalf configured');
  process.env.META_PIXEL_ID = '123456789';
  check('the browser half runs on the pixel id alone', meta.browserConfigured() === true);
  check('but the server half does not', meta.configured() === false);
  check('and says which half is missing',
    meta.warnings().some((w) => /META_ACCESS_TOKEN/.test(w)), JSON.stringify(meta.warnings()));

  console.log('\nwhat identifies a person');
  // Computed here, from the normalisation Meta specifies, with no reference
  // to how the code does it.
  const u = meta.userData({
    email: EMAIL, firstName: ' Tosyn ', lastName: "O'Gunniyi", externalId: USER_ID,
    ip: '102.89.1.4', userAgent: 'Mozilla/5.0', fbp: 'fb.1.123.456', fbc: 'fb.1.123.abc'
  });
  check('the email is trimmed, lowercased and hashed',
    u.em[0] === sha('tosyn.ogunniyi@example.ng'), u.em[0]);
  check('the first name is hashed', u.fn[0] === sha('tosyn'));
  check('and an apostrophe does not make a different person',
    u.ln[0] === sha('ogunniyi'), 'punctuation is stripped before hashing');
  check('the user id is hashed too', u.external_id[0] === sha(USER_ID));

  // The one that matters. Everything above could be right and this still
  // wrong, if a raw copy rode along in another field.
  const serialised = JSON.stringify(u);
  check('no raw email address appears anywhere in what is sent',
    !/tosyn\.ogunniyi@example\.ng/i.test(serialised) && !/Tosyn\.Ogunniyi/i.test(serialised),
    serialised);
  check('nor a raw name', !/Gunniyi/.test(serialised) && !/"Tosyn"/.test(serialised), serialised);
  check('nor the user id in the clear', !serialised.includes(USER_ID));

  check('the IP is sent as it is, because Meta specifies it unhashed',
    u.client_ip_address === '102.89.1.4');
  check('so is the user agent', u.client_user_agent === 'Mozilla/5.0');
  check('and so are Meta\'s own cookies', u.fbp === 'fb.1.123.456' && u.fbc === 'fb.1.123.abc');
  check('a person with nothing known about them produces no empty fields',
    Object.keys(meta.userData({})).length === 0, JSON.stringify(meta.userData({})));

  console.log('\nsending a sale');
  const good = graph();
  const port = await listen(good.server);
  process.env.META_ACCESS_TOKEN = 'EAAG-test-token';
  process.env.META_GRAPH_VERSION = 'v26.0';
  // Point the module at the stub. The path it builds is asserted below.
  process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:' + port;

  const result = await meta.send({
    name: 'Purchase',
    id: 'purchase-MNFY|20261014|0001',
    sourceUrl: 'https://profitna.com/',
    user: { email: EMAIL, externalId: USER_ID, ip: '102.89.1.4', userAgent: 'Mozilla/5.0' },
    custom: { value: 5000, currency: 'NGN', content_name: 'Profitna monthly', num_items: 1 }
  });
  check('it succeeds', result.ok === true, result.error);

  const req = good.seen[0];
  const event = req.body.data[0];
  check('one event goes in the data array', req.body.data.length === 1);
  check('under the name Meta knows', event.event_name === 'Purchase');
  check('with the id the browser also uses, so the sale counts once',
    event.event_id === 'purchase-MNFY|20261014|0001', event.event_id);
  check('marked as coming from the website', event.action_source === 'website');
  check('with the time in whole seconds, not milliseconds',
    Number.isInteger(event.event_time) && String(event.event_time).length === 10,
    String(event.event_time));
  check('the amount is naira, undivided',
    event.custom_data.value === 5000 && event.custom_data.currency === 'NGN',
    JSON.stringify(event.custom_data));

  check('the token travels in the body, not the query string',
    req.body.access_token === 'EAAG-test-token' && !req.url.includes('EAAG'),
    'a token on a URL ends up in access logs on the way out');
  check('the path carries the pinned version and the pixel id',
    req.url === '/v26.0/123456789/events', req.url);
  check('and the whole request still contains no readable email',
    !/tosyn\.ogunniyi@example\.ng/i.test(req.raw), 'the hash is the only form it may take');

  console.log('\nwhen Meta is unhappy');
  const bad = graph({ fail: true });
  const badPort = await listen(bad.server);
  process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:' + badPort;
  const refused = await meta.send({ name: 'Purchase', id: 'p2', user: { email: EMAIL } });
  check('a rejection is reported, not thrown',
    refused.ok === false && /Invalid OAuth access token/.test(refused.error), refused.error);

  process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:1';   // nothing listening there
  const unreachable = await meta.send({ name: 'Purchase', id: 'p3', user: {} });
  check('an unreachable Meta is reported, not thrown',
    unreachable.ok === false && /could not reach Meta/.test(unreachable.error), unreachable.error);

  // The whole point of track(): a signup must not fail, or wait, because an
  // advertising network is having a bad minute.
  const tracked = await meta.track({ name: 'CompleteRegistration', id: 'r1', user: {} });
  check('track() swallows the failure rather than passing it up', tracked.ok === false);
  check('and the console can see that something is wrong',
    meta.describe().failed > 0 && meta.describe().last.ok === false,
    JSON.stringify(meta.describe().last));

  console.log('\ntest mode');
  process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.META_TEST_EVENT_CODE = 'TEST12345';
  await meta.send({ name: 'Purchase', id: 'p4', user: {} });
  const testReq = good.seen[good.seen.length - 1];
  check('the code is sent so events show in Test Events',
    testReq.body.test_event_code === 'TEST12345');
  check('and it is called out loudly, because reporting stays at zero while it is on',
    meta.warnings().some((w) => /will NOT\s+appear in your ad reporting/.test(w)),
    JSON.stringify(meta.warnings()));
  delete process.env.META_TEST_EVENT_CODE;

  console.log('\nwhat the owner\'s console is told');
  const shown = meta.describe();
  check('whether it is on', shown.configured === true);
  check('which pixel', shown.pixel === '123456789');
  check('that a token exists', shown.hasToken === true);
  check('but never the token itself', !JSON.stringify(shown).includes('EAAG-test-token'));

  console.log('\nreading the browser back');
  const fromReq = meta.from({
    ip: '41.58.2.9',
    get: (h) => (h === 'user-agent' ? 'Chrome' : null),
    cookies: { _fbp: 'fb.1.9.9', _fbc: 'fb.1.9.click', session: 'not-for-meta' }
  });
  check('it takes Meta\'s own cookies', fromReq.fbp === 'fb.1.9.9' && fromReq.fbc === 'fb.1.9.click');
  check('and nothing else from the cookie jar',
    !JSON.stringify(fromReq).includes('not-for-meta'), JSON.stringify(fromReq));

  // ---------------------------------------------------------------- consent
  //
  // The browser half is gated by simply not loading the pixel. This is the
  // other half — the one that runs inside a signup or a payment where nobody
  // is watching, and that would otherwise send a hashed email to Meta whether
  // or not anybody ever answered the banner.
  console.log('\nconsent');

  const visitor = (cookies) => ({
    ip: '102.89.1.1',
    get: () => 'test-agent',
    cookies: cookies || {}
  });

  check('a visitor who has not been asked has not consented',
    meta.consented(visitor()) === false);
  check('a visitor who declined has not consented',
    meta.consented(visitor({ profitna_ads: 'off' })) === false);
  check('a visitor who accepted has',
    meta.consented(visitor({ profitna_ads: 'on' })) === true);
  check('and a cookie with any other value is not a yes',
    meta.consented(visitor({ profitna_ads: 'yes' })) === false &&
    meta.consented(visitor({ profitna_ads: 'true' })) === false &&
    meta.consented(visitor({ profitna_ads: '1' })) === false);

  // The real check: with the server fully configured and a working endpoint,
  // does an unconsented event actually stay on this machine?
  process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:' + port;
  const before = good.seen.length;

  const skipped = await meta.trackFor(visitor(), {
    name: 'CompleteRegistration',
    id: 'consent-test-1',
    sourceUrl: 'https://profitna.com/',
    user: Object.assign(meta.from(visitor()), { email: EMAIL, externalId: USER_ID })
  });
  check('an event for somebody who never agreed is not sent',
    good.seen.length === before, 'Meta received ' + (good.seen.length - before));
  check('and says why rather than failing silently',
    skipped && skipped.skipped === 'no advertising consent', JSON.stringify(skipped));

  const declinedEvent = await meta.trackFor(visitor({ profitna_ads: 'off' }), {
    name: 'Purchase',
    id: 'consent-test-2',
    sourceUrl: 'https://profitna.com/',
    user: Object.assign(meta.from(visitor({ profitna_ads: 'off' })), { email: EMAIL })
  });
  check('nor for somebody who declined',
    good.seen.length === before && declinedEvent.skipped,
    'Meta received ' + (good.seen.length - before));

  const allowed = await meta.trackFor(visitor({ profitna_ads: 'on' }), {
    name: 'CompleteRegistration',
    id: 'consent-test-3',
    sourceUrl: 'https://profitna.com/',
    user: Object.assign(meta.from(visitor({ profitna_ads: 'on' })), { email: EMAIL, externalId: USER_ID })
  });
  check('and one for somebody who agreed goes as it always did',
    allowed && allowed.ok === true && good.seen.length === before + 1,
    JSON.stringify(allowed));

  check('refusals are counted apart from failures',
    meta.describe().declined >= 2, JSON.stringify(meta.describe().declined));

  console.log('\nkeys pasted badly');
  process.env.META_PIXEL_ID = '"123456789"';
  check('quotes around a value are stripped, like the payment keys',
    meta.pixelId() === '123456789', meta.pixelId());

  await close(good.server);
  await close(bad.server);
  unconfigure();

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
