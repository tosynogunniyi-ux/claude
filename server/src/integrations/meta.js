// Meta ads: the server half of the tracking.
//
// Two halves report the same events. The pixel in the browser is the one Meta
// documents first, and it is the one that goes missing — ad blockers, iOS
// tracking prevention, a tab closed before the script finishes. The half here
// sends the same events from the server, where none of that applies and where
// we actually know whether a payment succeeded.
//
// Both halves send the same `event_id` for the same real action, and Meta
// keeps one. That is the whole trick: without a shared id the two halves
// double-count, and with it the browser's copy is a bonus rather than a
// liability. For a payment the id is the processor's own reference, so even a
// retried activation reports the same purchase once.
//
// What leaves this server: an email address, a name and a user id, each
// SHA-256 hashed, plus the IP, the user agent and Meta's own cookies. Never a
// raw address, never anything about the customer's books, never a card.
//
// Unset META_PIXEL_ID and none of this runs, in either half.

const crypto = require('crypto');

// Same cleaning as the payment and storage keys: a value pasted with quotes
// or a stray newline around it is the commonest way a correct token fails.
function conf(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return '';
  let v = String(raw).trim();
  const pairs = [['"', '"'], ["'", "'"], ['<', '>'], ['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (v.length > 2 && v.startsWith(open) && v.endsWith(close)) v = v.slice(1, -1).trim();
  }
  return v;
}

const pixelId = () => conf('META_PIXEL_ID');
const accessToken = () => conf('META_ACCESS_TOKEN');
const testCode = () => conf('META_TEST_EVENT_CODE');
const timeoutMs = () => Number(process.env.META_TIMEOUT_MS || 6000);

// Pinned rather than hard-coded. Meta retires a version about two years after
// it ships, and bumping it should be an environment change rather than a
// release. Check the Graph API changelog for the current one.
const version = () => conf('META_GRAPH_VERSION') || 'v26.0';

// The browser half needs only the id, which is public by design — it is in
// the page source of every site that advertises. The token never leaves here.
function configured() {
  return Boolean(pixelId() && accessToken());
}

// The pixel can run without a token; the server half cannot. Reported
// separately so a half-finished setup is visible rather than silent.
function browserConfigured() {
  return Boolean(pixelId());
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Meta hashes everything that identifies a person, and expects it normalised
// first so that the same person hashes to the same value from every source.
const normalise = {
  email: (v) => String(v || '').trim().toLowerCase(),
  // Letters only: "O'Brien" and "o brien" must not be two different people.
  name: (v) => String(v || '').trim().toLowerCase().replace(/[^\p{L}]/gu, ''),
  id: (v) => String(v || '').trim()
};

const hashed = (kind, value) => {
  const clean = normalise[kind](value);
  return clean ? sha256(clean) : null;
};

// Everything in here is either hashed or is not personal: an IP and a user
// agent Meta already sees on the pixel request, and two cookies Meta set
// itself. A raw email in this object would be the bug worth catching, so the
// test asserts it never appears.
function userData(user) {
  const u = user || {};
  const out = {};
  const em = hashed('email', u.email);
  const fn = hashed('name', u.firstName);
  const ln = hashed('name', u.lastName);
  const id = hashed('id', u.externalId);

  // Each field is an array: Meta takes more than one value per person.
  if (em) out.em = [em];
  if (fn) out.fn = [fn];
  if (ln) out.ln = [ln];
  if (id) out.external_id = [id];

  // Not hashed, by Meta's specification.
  if (u.ip) out.client_ip_address = String(u.ip);
  if (u.userAgent) out.client_user_agent = String(u.userAgent);
  if (u.fbp) out.fbp = String(u.fbp);
  if (u.fbc) out.fbc = String(u.fbc);
  return out;
}

// What the last attempt did, for the owner's console. In memory, like the
// backup module's: the point is to answer "are events arriving" without
// opening Events Manager, not to keep a record.
let last = null;
let sent = 0;
let failed = 0;

// The base is overridable for the test suite, and for a deployment that
// sends through its own proxy. Unset in production, where it should stay.
function endpoint() {
  const base = (conf('META_GRAPH_BASE_URL') || 'https://graph.facebook.com').replace(/\/+$/, '');
  return base + '/' + version() + '/' + pixelId() + '/events';
}

async function send(event) {
  if (!configured()) return { ok: false, skipped: true, error: 'Meta tracking is not configured' };

  const payload = {
    data: [{
      event_name: event.name,
      event_time: Math.floor((event.at ? new Date(event.at).getTime() : Date.now()) / 1000),
      // The pairing key. Both halves send this for the same action.
      event_id: event.id,
      action_source: 'website',
      event_source_url: event.sourceUrl || undefined,
      user_data: userData(event.user),
      custom_data: event.custom || undefined
    }],
    // In the body, not the query string: a token on a URL ends up in access
    // logs and proxy logs on the way out.
    access_token: accessToken()
  };
  // Makes events show in Events Manager's Test Events tab and keeps them out
  // of the real dataset. Unset it before trusting any number.
  if (testCode()) payload.test_event_code = testCode();

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs())
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || (body && body.error)) {
      const message = (body && body.error && body.error.message) || ('HTTP ' + res.status);
      return { ok: false, status: res.status, error: message, event: event.name };
    }
    return {
      ok: true,
      event: event.name,
      received: (body && body.events_received) || 0,
      test: Boolean(testCode())
    };
  } catch (err) {
    return { ok: false, error: 'could not reach Meta: ' + err.message, event: event.name };
  }
}

// What the routes call. Never throws, never waits: a signup must not be held
// up by an advertising network, and must certainly not fail because one is
// down. The caller does not await this.
function track(event) {
  if (!configured()) return Promise.resolve(null);
  return send(event)
    .then((result) => {
      last = Object.assign({ at: new Date().toISOString() }, result);
      if (result.ok) sent++;
      else {
        failed++;
        console.warn('meta: ' + event.name + ' not recorded — ' + result.error);
      }
      return result;
    })
    .catch((err) => {
      // send() handles its own failures; this is the belt to that braces.
      failed++;
      last = { at: new Date().toISOString(), ok: false, error: err.message, event: event.name };
      return null;
    });
}

// Everything the server knows about the browser that made this request, for
// matching. fbp and fbc are first-party cookies the pixel sets on our own
// domain, so they arrive here with any ordinary request.
function from(req) {
  const c = (req && req.cookies) || {};
  return {
    ip: req && req.ip,
    userAgent: req && req.get && req.get('user-agent'),
    fbp: c._fbp || null,
    fbc: c._fbc || null
  };
}

function describe() {
  return {
    configured: configured(),
    pixel: browserConfigured() ? pixelId() : null,
    hasToken: Boolean(accessToken()),
    graphVersion: version(),
    // Worth shouting about: while this is set, nothing reaches the real
    // dataset and every number in Ads Manager stays at zero.
    testMode: Boolean(testCode()),
    sent,
    failed,
    last
  };
}

function warnings() {
  const out = [];
  if (pixelId() && !accessToken()) {
    out.push('META_PIXEL_ID is set but META_ACCESS_TOKEN is not, so only the browser half ' +
      'of tracking runs. Events blocked in the browser will simply be lost.');
  }
  if (!pixelId() && accessToken()) {
    out.push('META_ACCESS_TOKEN is set but META_PIXEL_ID is not, so no events are sent at all.');
  }
  if (configured() && testCode()) {
    out.push('META_TEST_EVENT_CODE is set: events go to Test Events only and will NOT ' +
      'appear in your ad reporting. Unset it once you have seen them arrive.');
  }
  return out;
}

module.exports = {
  configured, browserConfigured, pixelId, version, track, send, from,
  userData, describe, warnings, conf, endpoint
};
