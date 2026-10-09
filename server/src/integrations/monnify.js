const crypto = require('crypto');

// Monnify (Moniepoint). Card details go from the browser straight to Monnify's
// SDK — this server only ever sees a reference and, once the payment is
// verified, the reusable card token that comes back with it.
//
// Two things differ from Paystack and both will bite anyone editing this file:
//
//   1. Amounts are in NAIRA, as a decimal. Paystack works in kobo. Everything
//      in this product already counts in naira, so nothing is multiplied here
//      — but a stray * 100 would charge a customer a hundred times over.
//   2. Every call needs a bearer token fetched with the API key and secret,
//      and it expires. That token is cached below rather than bought again on
//      every request.
//
// The exported surface is deliberately identical to integrations/paystack.js
// so src/integrations/gateway.js can hand either one to the rest of the app.

const LIVE = 'https://api.monnify.com';
const SANDBOX = 'https://sandbox.monnify.com';

// Refresh a little before the token actually dies, so a call never leaves with
// a credential that expires in flight.
const EXPIRY_SKEW_MS = 60 * 1000;

// Every call out to Monnify is bounded. Without this a host that cannot reach
// api.monnify.com — a closed outbound port, a DNS that does not resolve —
// leaves the request hanging until something in front of the app gives up and
// serves its own error page, which is HTML and tells the customer nothing. A
// refusal in fifteen seconds that says which host it could not reach is worth
// far more than a wait that never ends.
//
// Eight seconds, not fifteen, because the proxy in front of this app has its
// own patience and it is usually shorter. Losing the race means the customer
// gets the proxy's HTML error page instead of our explanation, which is the
// whole problem this was meant to solve.
function timeoutMs() {
  return Number(process.env.MONNIFY_TIMEOUT_MS || 8000);
}

// Credentials as pasted, cleaned of what pasting adds. A trailing newline
// from a copied line, a stray space, or the quotes and brackets people wrap a
// value in because a setup guide showed it that way — all of them travel into
// the Authorization header and come back as "invalid credentials", with
// nothing on screen to say the value merely has a space on the end.
//
// Only the wrapping is removed. Nothing inside the value is touched.
function conf(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return '';
  let v = String(raw).trim();
  const pairs = [['"', '"'], ["'", "'"], ['<', '>'], ['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (v.length > 2 && v.startsWith(open) && v.endsWith(close)) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

// True when a value only works because conf() cleaned it up — worth saying so
// rather than silently papering over a setting that is wrong on disk.
function needsTidying(name) {
  const raw = process.env[name];
  return raw !== undefined && raw !== null && String(raw) !== conf(name) && conf(name) !== '';
}

function base() {
  if (process.env.MONNIFY_BASE_URL) return process.env.MONNIFY_BASE_URL.replace(/\/+$/, '');
  return process.env.MONNIFY_ENV === 'live' ? LIVE : SANDBOX;
}

function isLive() {
  return base() === LIVE;
}

// Things about the configuration that are worth saying out loud before a real
// card is involved. Each one is a mismatch that otherwise shows up as a failed
// payment by a customer, which is an expensive way to find out.
function warnings() {
  const out = [];
  if (!configured()) return out;
  const key = conf('MONNIFY_API_KEY');

  for (const name of ['MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE']) {
    if (needsTidying(name)) {
      out.push(name + ' has quotes, brackets or spaces around it. They are being ignored, ' +
        'but the value should be the bare key with nothing wrapped around it.');
    }
  }
  if (process.env.MONNIFY_BASE_URL) {
    out.push('MONNIFY_BASE_URL is set to ' + base() + ', which overrides MONNIFY_ENV entirely. ' +
      'Unset it unless you are pointing at a test double on purpose.');
  }
  if (isLive() && /^MK_TEST_/i.test(key)) {
    out.push('MONNIFY_ENV is live but MONNIFY_API_KEY is a test key (MK_TEST_…). ' +
      'Live mode will reject it. Use the live key from the live dashboard.');
  }
  if (!isLive() && /^MK_PROD_/i.test(key)) {
    out.push('MONNIFY_API_KEY looks like a live key (MK_PROD_…) but MONNIFY_ENV is not live, ' +
      'so it is being sent to the sandbox, which will reject it. Set MONNIFY_ENV=live.');
  }
  // The sandbox and live dashboards issue different contract codes. A live key
  // with a sandbox contract code authenticates and then fails at the point of
  // taking money, which is the worst time to find out.
  if (isLive() && !conf('MONNIFY_CONTRACT_CODE')) {
    out.push('MONNIFY_CONTRACT_CODE is not set.');
  }
  return out;
}

// fetch, but it always comes back. AbortSignal.timeout raises a TimeoutError;
// a refused connection or an unresolvable name raises its own. All of them
// mean the same thing to the caller, so all of them say so the same way.
async function fetchMonnify(url, options, overrideMs) {
  const ms = overrideMs || timeoutMs();
  try {
    return await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(ms) }));
  } catch (err) {
    const why = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? 'it did not answer within ' + Math.round(ms / 1000) + ' seconds'
      : (err && err.message) || String(err);
    throw new Error(
      'Could not reach Monnify at ' + base() + ' — ' + why +
      '. Check that this server has outbound internet access and that MONNIFY_ENV (' +
      (process.env.MONNIFY_ENV || 'sandbox') + ') points at the right host.'
    );
  }
}

function configured() {
  return Boolean(
    conf('MONNIFY_API_KEY') &&
    conf('MONNIFY_SECRET_KEY') &&
    conf('MONNIFY_CONTRACT_CODE')
  );
}

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

let cached = null; // { token, expiresAt }
let inFlight = null;

async function login() {
  const basic = Buffer
    .from(conf('MONNIFY_API_KEY') + ':' + conf('MONNIFY_SECRET_KEY'))
    .toString('base64');

  const res = await fetchMonnify(base() + '/api/v1/auth/login', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' }
  });
  const body = await res.json().catch(() => null);
  const data = body && body.responseBody;
  if (!res.ok || !body || !body.requestSuccessful || !data || !data.accessToken) {
    const why = (body && body.responseMessage) || ('HTTP ' + res.status);
    // Naming the host is most of the diagnosis. By far the commonest cause of
    // a rejected key is live credentials sent to the sandbox or the other way
    // round, and the two look identical until you see which one was called.
    throw new Error(
      'Monnify rejected the API credentials at ' + base() + ' — ' + why +
      '. Check MONNIFY_API_KEY and MONNIFY_SECRET_KEY, and that MONNIFY_ENV (' +
      (process.env.MONNIFY_ENV || 'sandbox') + ') matches the keys you were given.'
    );
  }

  // expiresIn is seconds. Default to an hour if it is ever missing rather than
  // caching a token forever.
  const ttl = (Number(data.expiresIn) || 3600) * 1000;
  cached = { token: data.accessToken, expiresAt: Date.now() + ttl - EXPIRY_SKEW_MS };
  return cached.token;
}

async function token() {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  // One login at a time. The scheduler charges in batches, and without this
  // every row in the batch would buy its own token on a cold cache.
  if (!inFlight) {
    inFlight = login().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function call(path, { method = 'GET', body } = {}) {
  const send = async (bearer) => fetchMonnify(base() + path, {
    method,
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let res = await send(await token());
  // A token can be revoked or expire early. One forced re-login, then give up:
  // retrying past that would turn an auth problem into a charge loop.
  if (res.status === 401) {
    cached = null;
    res = await send(await token());
  }
  const parsed = await res.json().catch(() => null);
  return { res, body: parsed };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

// Opens a transaction so the browser has something to pay against. Returns the
// checkout URL and both references — Monnify's own and ours.
async function initTransaction({ amountNaira, email, name, reference, description, redirectUrl }) {
  if (!configured()) throw new Error('Monnify is not configured');

  const body = {
    amount: Number(amountNaira),
    customerName: name || email,
    customerEmail: email,
    paymentReference: reference,
    paymentDescription: description || 'Profitna subscription',
    currencyCode: 'NGN',
    contractCode: conf('MONNIFY_CONTRACT_CODE')
  };
  // Both of these are rejected outright if the merchant account does not have
  // them enabled, so neither is sent unless it is asked for. Left out, Monnify
  // offers whatever the contract actually supports, which is what we want.
  if (redirectUrl) body.redirectUrl = redirectUrl;
  if (process.env.MONNIFY_PAYMENT_METHODS) {
    body.paymentMethods = process.env.MONNIFY_PAYMENT_METHODS.split(',').map((m) => m.trim()).filter(Boolean);
  }

  const { res, body: out } = await call('/api/v1/merchant/transactions/init-transaction', {
    method: 'POST',
    body
  });

  const data = out && out.responseBody;
  if (!res.ok || !out || !out.requestSuccessful || !data) {
    throw new Error('Monnify could not start that payment: ' +
      ((out && out.responseMessage) || ('HTTP ' + res.status)) +
      ' (contract ' + conf('MONNIFY_CONTRACT_CODE') + ' at ' + base() + ')');
  }
  return {
    checkoutUrl: data.checkoutUrl,
    transactionReference: data.transactionReference,
    paymentReference: data.paymentReference || reference
  };
}

// Monnify brands cards in a few different fields depending on the endpoint and
// the card. Rather than guess one, take the first that is actually present.
function cardFrom(details) {
  if (!details) return null;
  const last4 = details.last4 || details.maskedPan ? String(details.last4 || details.maskedPan).slice(-4) : null;
  if (!last4) return null;
  const month = details.expMonth || details.expiryMonth;
  const year = details.expYear || details.expiryYear;
  return {
    brand: details.cardType || details.brand || details.scheme || 'Card',
    last4,
    exp: month && year ? month + '/' + String(year).slice(-2) : null
  };
}

// Confirms a completed payment and returns what we may store. Shape matches
// paystack.verify() exactly — authorizationCode carries Monnify's card token.
async function verify(reference, email) {
  if (!configured() || !reference) return null;

  const { res, body } = await call(
    '/api/v2/transactions/' + encodeURIComponent(reference)
  );
  const data = body && body.responseBody;
  if (!res.ok || !body || !body.requestSuccessful || !data) return null;

  // PAID is the settled state. PARTIALLY_PAID and OVERPAID are deliberately
  // not treated as success — the amount check in the caller decides what a
  // short payment means, and it needs a real figure to check.
  if (String(data.paymentStatus).toUpperCase() !== 'PAID') return null;

  const customerEmail = data.customer && data.customer.email;
  if (email && customerEmail && String(customerEmail).toLowerCase() !== String(email).toLowerCase()) {
    return null;
  }

  const details = data.cardDetails || {};
  return {
    provider: 'monnify',
    customerId: customerEmail || null,
    // Present only when tokenisation is enabled on the merchant account. Without
    // it the subscription simply has no card on file and will not auto-renew.
    authorizationCode: details.cardToken || null,
    reference: data.transactionReference || reference,
    // Already naira. No division.
    amount: Number(data.amountPaid || data.totalPayable || 0),
    currency: data.currencyCode || 'NGN',
    channel: data.paymentMethod || null,
    paidAt: data.paidOn || data.completedOn || null,
    card: cardFrom(details)
  };
}

// Charges a stored card token — what runs when a trial ends or a plan renews.
async function chargeAuthorization({ authorizationCode, email, amountNaira, reference, name }) {
  if (!configured()) throw new Error('Monnify is not configured');

  const { res, body } = await call('/api/v1/merchant/cards/charge-card-token', {
    method: 'POST',
    body: {
      cardToken: authorizationCode,
      amount: Number(amountNaira),
      customerName: name || email,
      customerEmail: email,
      paymentReference: reference,
      paymentDescription: 'Profitna subscription renewal',
      currencyCode: 'NGN',
      contractCode: conf('MONNIFY_CONTRACT_CODE'),
      apiKey: conf('MONNIFY_API_KEY')
    }
  });

  const data = (body && body.responseBody) || {};
  const status = String(data.status || data.paymentStatus || '').toUpperCase();
  const ok = Boolean(res.ok && body && body.requestSuccessful &&
    (status === 'PAID' || status === 'SUCCESS'));

  // The caller reads body.message for the decline reason, as it does for
  // Paystack, so give it one in the same place.
  return {
    ok,
    body: {
      message: (body && body.responseMessage) || data.responseMessage || 'charge declined',
      data
    }
  };
}

// Monnify signs webhooks with HMAC-SHA512 over the raw body, keyed by the
// secret key, and sends it in the monnify-signature header.
function verifyWebhook(rawBody, signature) {
  if (!configured() || !signature) return false;
  const expected = crypto
    .createHmac('sha512', conf('MONNIFY_SECRET_KEY'))
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only for tests: drops the cached bearer token.
function _resetToken() { cached = null; inFlight = null; }

// Authenticates and nothing else, on a leash of its own, bypassing the token
// cache so it reports what the credentials do right now rather than what they
// did an hour ago. Nothing is charged and no transaction is opened.
async function ping(ms) {
  if (!configured()) throw new Error('Monnify is not configured');
  const basic = Buffer
    .from(conf('MONNIFY_API_KEY') + ':' + conf('MONNIFY_SECRET_KEY'))
    .toString('base64');

  const res = await fetchMonnify(base() + '/api/v1/auth/login', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' }
  }, ms || 6000);

  const body = await res.json().catch(() => null);
  const data = body && body.responseBody;
  if (!res.ok || !body || !body.requestSuccessful || !data || !data.accessToken) {
    throw new Error('Monnify rejected the API credentials at ' + base() + ' — ' +
      ((body && body.responseMessage) || ('HTTP ' + res.status)));
  }
  return true;
}

module.exports = {
  name: 'monnify',
  configured,
  verify,
  chargeAuthorization,
  verifyWebhook,
  initTransaction,
  ping,
  base,
  conf,
  isLive,
  warnings,
  _resetToken
};
