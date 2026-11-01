// Talking to a payment gateway with a tenant's own credentials.
//
// This is deliberately not src/integrations/paystack.js or monnify.js. Those
// two read PAYMENT_PROVIDER, PAYSTACK_SECRET_KEY, MONNIFY_API_KEY and the rest
// from the environment, because they collect **Profitna's own subscription
// fees** into Profitna's own merchant account. Nothing in this file reads an
// environment variable. Every call takes the credentials it is given, and
// those come from the organisation whose invoice is being paid.
//
// That separation is the whole architecture of this release. A customer paying
// Adeola's invoice pays Adeola's Paystack account. The money never passes
// through Profitna, Profitna never holds it, and there is no code path by
// which a tenant's customer payment could be initiated against Profitna's
// keys — because those keys are not reachable from here.
//
// Both providers are reduced to the same five operations and the same return
// shapes, so the routes, the webhook and the receipts module never learn which
// gateway a given organisation uses.

const crypto = require('crypto');
const money = require('../money');

// Every call out is bounded, for the reason learned the hard way on the
// subscription path: without a timeout, a host that cannot reach the gateway
// leaves the request hanging until the proxy in front of the app serves its
// own HTML, and the customer is told nothing. Eight seconds, under the
// proxy's own patience, so our explanation wins the race.
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 8000);

async function fetchJson(url, options, label) {
  let res;
  try {
    res = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
  } catch (err) {
    const why = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? 'it did not answer within ' + Math.round(TIMEOUT_MS / 1000) + ' seconds'
      : (err && err.message) || String(err);
    throw gatewayError('Could not reach ' + label + ' at ' + host(url) + ' — ' + why + '.');
  }
  const body = await res.json().catch(() => null);
  return { res, body };
}

function host(url) {
  try { return new URL(url).host; } catch { return url; }
}

// 424, never 5xx. A gateway refusing a credential is something we are
// deliberately reporting to a person, and the proxy in front of this app
// replaces a 5xx body with its own error page — which is how every careful
// message about Monnify came to be thrown away at the last hop once before.
function gatewayError(message) {
  const err = new Error(message);
  err.status = 424;
  err.code = 'GATEWAY_UNREACHABLE';
  return err;
}

// Constant-time comparison of two hex digests, length-checked first because
// timingSafeEqual throws on a length mismatch rather than returning false.
function sameDigest(expected, given) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ Paystack

const paystack = {
  name: 'paystack',
  label: 'Paystack',
  // What the settings screen asks for, and which of them may reach a browser.
  fields: [
    { key: 'publicKey', label: 'Public key', secret: false, placeholder: 'pk_live_…', required: true },
    { key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_…', required: true }
  ],
  // The header the provider signs its webhooks in.
  signatureHeader: 'x-paystack-signature',
  dashboard: 'https://dashboard.paystack.com/#/settings/developers',
  instructions:
    'Paystack dashboard → Settings → API Keys & Webhooks. Copy the public and ' +
    'secret keys, then paste the webhook URL shown below into the same page.',

  base() { return 'https://api.paystack.co'; },

  // A key that says live while the account is in test, or the other way
  // round, authenticates and then fails at the point of taking money. Said
  // here rather than discovered by a customer.
  review(creds) {
    const out = [];
    const secret = String(creds.secretKey || '');
    const pub = String(creds.publicKey || '');
    if (secret && !/^sk_(test|live)_/.test(secret)) {
      out.push('That does not look like a Paystack secret key. They begin sk_test_ or sk_live_.');
    }
    if (pub && !/^pk_(test|live)_/.test(pub)) {
      out.push('That does not look like a Paystack public key. They begin pk_test_ or pk_live_.');
    }
    const secretLive = /^sk_live_/.test(secret);
    const pubLive = /^pk_live_/.test(pub);
    if (secret && pub && secretLive !== pubLive) {
      out.push('One of these keys is live and the other is a test key. Both must come from the same mode.');
    }
    if (creds.environment === 'live' && secret && !secretLive) {
      out.push('This account is set to live but the secret key is a test key, so no real payment will succeed.');
    }
    if (creds.environment === 'test' && secretLive) {
      out.push('This is a live secret key saved against a test account. Real cards will be charged.');
    }
    return out;
  },

  headers(creds) {
    return {
      Authorization: 'Bearer ' + creds.secretKey,
      'Content-Type': 'application/json'
    };
  },

  // Authenticates and reads nothing that could change anything. Used to prove
  // a credential before it is marked active, because "saved" and "works" are
  // different claims and only one of them should put a Pay button on an
  // invoice.
  async ping(creds) {
    const { res, body } = await fetchJson(
      this.base() + '/transaction?perPage=1', { headers: this.headers(creds) }, 'Paystack'
    );
    if (res.status === 401 || res.status === 403) {
      throw gatewayError('Paystack refused that secret key. Check it was copied in full from the dashboard.');
    }
    if (!res.ok || !body || body.status !== true) {
      throw gatewayError('Paystack answered but refused the request: ' +
        ((body && body.message) || ('HTTP ' + res.status)) + '.');
    }
    return { ok: true, mode: /^sk_live_/.test(String(creds.secretKey)) ? 'live' : 'test' };
  },

  // Opens a hosted checkout. Paystack counts in kobo, which is what this
  // whole codebase counts in, so nothing is converted.
  async initialise(creds, { amountKobo, email, name, reference, callbackUrl, description, metadata }) {
    const { res, body } = await fetchJson(this.base() + '/transaction/initialize', {
      method: 'POST',
      headers: this.headers(creds),
      body: JSON.stringify({
        amount: Math.round(amountKobo),
        email,
        reference,
        currency: 'NGN',
        callback_url: callbackUrl || undefined,
        metadata: Object.assign({ custom_fields: [] }, metadata || {}, {
          customer_name: name || undefined,
          description: description || undefined
        })
      })
    }, 'Paystack');

    const data = body && body.data;
    if (!res.ok || !body || body.status !== true || !data || !data.authorization_url) {
      throw gatewayError('Paystack could not start that payment: ' +
        ((body && body.message) || ('HTTP ' + res.status)) + '.');
    }
    return {
      url: data.authorization_url,
      reference: data.reference || reference,
      accessCode: data.access_code || null
    };
  },

  // The only statement about a payment this server trusts: the provider's own
  // answer, asked for with the tenant's own secret key.
  async verify(creds, reference) {
    const { res, body } = await fetchJson(
      this.base() + '/transaction/verify/' + encodeURIComponent(reference),
      { headers: this.headers(creds) }, 'Paystack'
    );
    if (res.status === 404 || (body && body.status === false && /not found/i.test(String(body.message)))) {
      return { found: false, status: 'unknown', reference };
    }
    const data = body && body.data;
    if (!res.ok || !body || body.status !== true || !data) {
      throw gatewayError('Paystack could not confirm that payment: ' +
        ((body && body.message) || ('HTTP ' + res.status)) + '.');
    }

    const state = String(data.status || '').toLowerCase();
    return {
      found: true,
      status: state === 'success' ? 'paid' : state === 'failed' || state === 'abandoned' ? 'failed' : 'pending',
      reference: data.reference || reference,
      providerReference: String(data.id || data.reference || reference),
      // Already kobo, as integers.
      amountKobo: Math.round(Number(data.amount) || 0),
      feeKobo: Math.round(Number(data.fees) || 0),
      currency: data.currency || 'NGN',
      channel: data.channel || null,
      paidAt: data.paid_at || data.paidAt || null,
      customer: {
        email: (data.customer && data.customer.email) || null,
        name: [data.customer && data.customer.first_name, data.customer && data.customer.last_name]
          .filter(Boolean).join(' ') || null
      },
      raw: { gateway_response: data.gateway_response || null }
    };
  },

  // HMAC-SHA512 of the raw body, keyed by the secret key. The raw body, not a
  // re-serialised object: JSON.stringify of a parsed payload reorders nothing
  // in practice and everything in principle, and the signature is over bytes.
  verifyWebhook(creds, rawBody, signature) {
    if (!creds.secretKey) return false;
    const expected = crypto.createHmac('sha512', creds.secretKey).update(rawBody).digest('hex');
    return sameDigest(expected, signature);
  },

  // What a webhook is about, without trusting anything else in it.
  eventReference(payload) {
    const data = (payload && payload.data) || {};
    const event = String((payload && payload.event) || '');
    if (!/^charge\./.test(event) && event !== 'transfer.success') return null;
    return data.reference ? String(data.reference) : null;
  }
};

// ------------------------------------------------------------------- Monnify

const monnify = {
  name: 'monnify',
  label: 'Monnify (Moniepoint)',
  fields: [
    { key: 'publicKey', label: 'API key', secret: false, placeholder: 'MK_PROD_…', required: true },
    { key: 'secretKey', label: 'Secret key', secret: true, placeholder: '', required: true },
    { key: 'contractCode', label: 'Contract code', secret: false, placeholder: '', required: true }
  ],
  signatureHeader: 'monnify-signature',
  dashboard: 'https://app.monnify.com',
  instructions:
    'Monnify dashboard → Settings → API Keys & Webhooks. The sandbox and live ' +
    'dashboards are separate accounts with separate keys and separate contract ' +
    'codes — all three values change together. Paste the webhook URL shown ' +
    'below into the same page.',

  base(creds) {
    return creds.environment === 'live' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com';
  },

  review(creds) {
    const out = [];
    const key = String(creds.publicKey || '');
    if (key && !/^MK_(TEST|PROD)_/i.test(key)) {
      out.push('That does not look like a Monnify API key. They begin MK_TEST_ or MK_PROD_.');
    }
    if (creds.environment === 'live' && /^MK_TEST_/i.test(key)) {
      out.push('This account is set to live but the API key is a test key (MK_TEST_…). Live mode will reject it.');
    }
    if (creds.environment !== 'live' && /^MK_PROD_/i.test(key)) {
      out.push('This is a live API key (MK_PROD_…) saved against a test account, so it is being sent to ' +
        'the sandbox, which will reject it. Switch the account to live.');
    }
    if (!creds.contractCode) {
      out.push('Monnify needs the contract code from the same dashboard as the keys.');
    }
    return out;
  },

  // A bearer token per call rather than a process-wide cache: the cache in
  // integrations/monnify.js is correct because there is one set of
  // credentials, and would be a cross-tenant leak here. Tokens are cached
  // per organisation by the caller instead.
  async token(creds) {
    const basic = Buffer.from(String(creds.publicKey) + ':' + String(creds.secretKey)).toString('base64');
    const { res, body } = await fetchJson(this.base(creds) + '/api/v1/auth/login', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' }
    }, 'Monnify');

    const data = body && body.responseBody;
    if (!res.ok || !body || !body.requestSuccessful || !data || !data.accessToken) {
      throw gatewayError(
        'Monnify refused those credentials at ' + host(this.base(creds)) + ' — ' +
        ((body && body.responseMessage) || ('HTTP ' + res.status)) +
        '. Check the API key and secret, and that the account is set to the same ' +
        'mode (test or live) as the dashboard they came from.'
      );
    }
    return { token: data.accessToken, expiresIn: Number(data.expiresIn) || 3600 };
  },

  async call(creds, path, { method = 'GET', body, token } = {}) {
    const bearer = token || (await this.token(creds)).token;
    return fetchJson(this.base(creds) + path, {
      method,
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, 'Monnify');
  },

  async ping(creds) {
    await this.token(creds);
    return { ok: true, mode: creds.environment === 'live' ? 'live' : 'test' };
  },

  // Monnify counts in NAIRA, as a decimal. Nothing in this codebase does, so
  // this is the one place the conversion happens — out here at the wire,
  // where it can be read next to the field it applies to.
  async initialise(creds, { amountKobo, email, name, reference, callbackUrl, description, token }) {
    const payload = {
      amount: money.toNaira(amountKobo),
      customerName: name || email,
      customerEmail: email,
      paymentReference: reference,
      paymentDescription: description || 'Invoice payment',
      currencyCode: 'NGN',
      contractCode: creds.contractCode
    };
    if (callbackUrl) payload.redirectUrl = callbackUrl;

    const { res, body } = await this.call(creds, '/api/v1/merchant/transactions/init-transaction', {
      method: 'POST', body: payload, token
    });

    const data = body && body.responseBody;
    if (!res.ok || !body || !body.requestSuccessful || !data || !data.checkoutUrl) {
      throw gatewayError('Monnify could not start that payment: ' +
        ((body && body.responseMessage) || ('HTTP ' + res.status)) +
        ' (contract ' + creds.contractCode + ').');
    }
    return {
      url: data.checkoutUrl,
      reference: data.paymentReference || reference,
      transactionReference: data.transactionReference || null
    };
  },

  async verify(creds, reference, token) {
    const { res, body } = await this.call(
      creds, '/api/v2/transactions/' + encodeURIComponent(reference), { token }
    );
    if (res.status === 404) return { found: false, status: 'unknown', reference };

    const data = body && body.responseBody;
    if (!res.ok || !body || !body.requestSuccessful || !data) {
      const why = (body && body.responseMessage) || ('HTTP ' + res.status);
      if (/not.*found|does not exist/i.test(String(why))) {
        return { found: false, status: 'unknown', reference };
      }
      throw gatewayError('Monnify could not confirm that payment: ' + why + '.');
    }

    const state = String(data.paymentStatus || '').toUpperCase();
    // PAID is the settled state. PARTIALLY_PAID and OVERPAID are reported as
    // themselves rather than flattened into success or failure: a customer who
    // has paid part of an invoice has paid part of an invoice, and the amount
    // is what decides what that means.
    const paid = state === 'PAID' || state === 'PARTIALLY_PAID' || state === 'OVERPAID';
    const gross = money.toKobo(String(data.amountPaid || data.totalPayable || 0));
    const settled = data.settlementAmount === undefined || data.settlementAmount === null
      ? null : money.toKobo(String(data.settlementAmount));

    return {
      found: true,
      status: paid ? 'paid'
        : state === 'FAILED' || state === 'CANCELLED' || state === 'EXPIRED' ? 'failed' : 'pending',
      providerState: state,
      reference: data.paymentReference || reference,
      providerReference: String(data.transactionReference || data.paymentReference || reference),
      amountKobo: gross,
      // Monnify reports what it will settle, not what it kept. The difference
      // is the fee, and it is only knowable when both figures are present.
      feeKobo: settled === null ? 0 : Math.max(gross - settled, 0),
      currency: data.currencyCode || 'NGN',
      channel: data.paymentMethod || null,
      paidAt: data.paidOn || data.completedOn || null,
      customer: {
        email: (data.customer && data.customer.email) || null,
        name: (data.customer && data.customer.name) || null
      },
      raw: { settlementAmount: settled }
    };
  },

  verifyWebhook(creds, rawBody, signature) {
    if (!creds.secretKey) return false;
    const expected = crypto.createHmac('sha512', creds.secretKey).update(rawBody).digest('hex');
    return sameDigest(expected, signature);
  },

  eventReference(payload) {
    const event = String((payload && payload.eventType) || '');
    const data = (payload && payload.eventData) || {};
    if (!/TRANSACTION|SETTLEMENT/i.test(event)) return null;
    // The transaction reference is Monnify's own id and is what /api/v2 reads.
    return data.transactionReference ? String(data.transactionReference)
      : data.paymentReference ? String(data.paymentReference) : null;
  }
};

const ALL = { paystack, monnify };
const NAMES = Object.keys(ALL);

function get(name) {
  const p = ALL[String(name || '').toLowerCase()];
  if (!p) {
    const err = new Error('Unknown payment provider. Profitna supports ' + NAMES.join(' and ') + '.');
    err.status = 400;
    throw err;
  }
  return p;
}

// What the settings screen needs to draw the form, with no secret in it.
function describe() {
  return NAMES.map((n) => ({
    name: n,
    label: ALL[n].label,
    fields: ALL[n].fields,
    instructions: ALL[n].instructions,
    dashboard: ALL[n].dashboard,
    signatureHeader: ALL[n].signatureHeader
  }));
}

module.exports = { get, describe, ALL, NAMES, gatewayError, sameDigest, TIMEOUT_MS };
