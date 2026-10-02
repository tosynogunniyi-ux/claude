// Does the Monnify integration do what Monnify actually expects?
//   npm run test:monnify
//
// Runs in process with fetch stubbed, because the alternative is charging a
// real card. What is tested is the part that is ours and can be wrong: the
// bearer-token cache, the naira-not-kobo amount, the shape verify() returns,
// webhook signatures, which provider the gateway picks, and that a card stored
// with one processor is never sent to another.

require('dotenv').config();
const crypto = require('crypto');
const assert = require('assert');

const monnify = require('../src/integrations/monnify');
const paystack = require('../src/integrations/paystack');
const gateway = require('../src/integrations/gateway');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

// --- the stub ---------------------------------------------------------------
// Records every call so the assertions can look at what was actually sent,
// which is the only way to catch a wrong unit or a missing field.

const realFetch = global.fetch;
let calls = [];
let handlers = {};

function stubFetch() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body });

    const key = Object.keys(handlers).find((k) => u.includes(k));
    const reply = key ? handlers[key] : null;
    if (!reply) return { ok: false, status: 404, json: async () => ({ requestSuccessful: false }) };
    const r = typeof reply === 'function' ? reply(body, calls.length) : reply;
    return {
      ok: r.status === undefined ? true : r.status < 400,
      status: r.status || 200,
      json: async () => r.json
    };
  };
}

function reset() {
  calls = [];
  handlers = {};
  monnify._resetToken();
}

const ENV = {
  MONNIFY_API_KEY: 'MK_TEST_ABC123',
  MONNIFY_SECRET_KEY: 'SECRET_XYZ',
  MONNIFY_CONTRACT_CODE: '7059707855'
};

function withMonnify() {
  Object.assign(process.env, ENV);
  process.env.MONNIFY_ENV = 'sandbox';
  delete process.env.PAYMENT_PROVIDER;
}

function withoutMonnify() {
  delete process.env.MONNIFY_API_KEY;
  delete process.env.MONNIFY_SECRET_KEY;
  delete process.env.MONNIFY_CONTRACT_CODE;
}

const LOGIN_OK = {
  json: { requestSuccessful: true, responseBody: { accessToken: 'TOKEN_1', expiresIn: 3600 } }
};

(async () => {
  stubFetch();

  // =========================================================================
  console.log('\nconfiguration');
  // =========================================================================
  reset();
  withoutMonnify();
  check('off until its keys are set', monnify.configured() === false);

  withMonnify();
  check('on once api key, secret and contract code are present', monnify.configured() === true);

  delete process.env.MONNIFY_CONTRACT_CODE;
  check('a missing contract code is not "configured"', monnify.configured() === false,
    'init-transaction and charge-card-token both require it');
  withMonnify();

  process.env.MONNIFY_ENV = 'sandbox';
  check('sandbox by default', monnify.base() === 'https://sandbox.monnify.com');
  process.env.MONNIFY_ENV = 'live';
  check('live when asked', monnify.base() === 'https://api.monnify.com');
  process.env.MONNIFY_ENV = 'sandbox';

  // =========================================================================
  console.log('\nthe access token');
  // =========================================================================
  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: { requestSuccessful: true, responseBody: { paymentStatus: 'PAID', amountPaid: 10000 } }
  };

  await monnify.verify('MNFY|1', null);
  const login = calls.find((c) => c.url.includes('/auth/login'));
  check('logs in before calling anything else', Boolean(login) && calls.indexOf(login) === 0);
  check('with Basic auth over apiKey:secretKey',
    login.headers.Authorization ===
      'Basic ' + Buffer.from(ENV.MONNIFY_API_KEY + ':' + ENV.MONNIFY_SECRET_KEY).toString('base64'));
  check('and sends the bearer token on the real call',
    calls[1].headers.Authorization === 'Bearer TOKEN_1');

  const before = calls.length;
  await monnify.verify('MNFY|2', null);
  check('the token is cached, not bought again',
    calls.slice(before).filter((c) => c.url.includes('/auth/login')).length === 0);

  // Two calls racing a cold cache must still only log in once.
  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: { requestSuccessful: true, responseBody: { paymentStatus: 'PAID', amountPaid: 1 } }
  };
  await Promise.all([monnify.verify('MNFY|a'), monnify.verify('MNFY|b'), monnify.verify('MNFY|c')]);
  check('three concurrent calls share one login',
    calls.filter((c) => c.url.includes('/auth/login')).length === 1);

  // An expired token gets exactly one retry.
  reset();
  let loginCount = 0;
  handlers['/api/v1/auth/login'] = () => {
    loginCount++;
    return { json: { requestSuccessful: true, responseBody: { accessToken: 'T' + loginCount, expiresIn: 3600 } } };
  };
  let seen = 0;
  handlers['/api/v2/transactions/'] = () => {
    seen++;
    if (seen === 1) return { status: 401, json: { requestSuccessful: false } };
    return { json: { requestSuccessful: true, responseBody: { paymentStatus: 'PAID', amountPaid: 500 } } };
  };
  const retried = await monnify.verify('MNFY|expired');
  check('a 401 forces one fresh login and retries', loginCount === 2 && retried !== null);

  // A bad key must throw something a human can act on, not a TypeError.
  reset();
  handlers['/api/v1/auth/login'] = {
    status: 401,
    json: { requestSuccessful: false, responseMessage: 'Invalid credentials' }
  };
  let authErr = null;
  try { await monnify.chargeAuthorization({ authorizationCode: 'x', email: 'a@b.ng', amountNaira: 1, reference: 'r' }); }
  catch (e) { authErr = e; }
  check('bad credentials raise a readable error',
    Boolean(authErr) && /Invalid credentials/.test(authErr.message), authErr && authErr.message);
  check('and name the host they were sent to',
    /sandbox\.monnify\.com/.test(authErr.message),
    'live keys against the sandbox look exactly like a wrong key until you see the host');
  check('and the env setting that chose it', /MONNIFY_ENV/.test(authErr.message));

  // =========================================================================
  console.log('\nopening a transaction');
  // =========================================================================
  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/init-transaction'] = {
    json: { requestSuccessful: true, responseBody: {
      checkoutUrl: 'https://sandbox.sdk.monnify.com/checkout/X',
      transactionReference: 'MNFY|INIT|1', paymentReference: 'profitna-1-2' } }
  };

  const started = await monnify.initTransaction({
    amountNaira: 5000, email: 'owner@mideops.ng', name: 'Mideops', reference: 'profitna-1-2'
  });
  const initBody = calls.find((c) => c.url.includes('init-transaction')).body;
  check('the checkout url comes back', started.checkoutUrl.includes('/checkout/'));
  check('amount is naira here too', initBody.amount === 5000);
  check('contract code is sent', initBody.contractCode === ENV.MONNIFY_CONTRACT_CODE);
  check('paymentMethods is left out unless asked for',
    !('paymentMethods' in initBody),
    'naming a method the contract does not have gets the whole call rejected');
  check('redirectUrl is left out when there is none', !('redirectUrl' in initBody));

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/init-transaction'] = { json: { requestSuccessful: true, responseBody: { checkoutUrl: 'u' } } };
  process.env.MONNIFY_PAYMENT_METHODS = 'CARD, ACCOUNT_TRANSFER';
  await monnify.initTransaction({ amountNaira: 1, email: 'a@b.ng', reference: 'r' });
  check('but is sent when it is configured',
    JSON.stringify(calls.find((c) => c.url.includes('init-transaction')).body.paymentMethods) ===
      '["CARD","ACCOUNT_TRANSFER"]');
  delete process.env.MONNIFY_PAYMENT_METHODS;

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/init-transaction'] = {
    status: 400,
    json: { requestSuccessful: false, responseMessage: 'Invalid contract code' }
  };
  let initErr = null;
  try { await monnify.initTransaction({ amountNaira: 1, email: 'a@b.ng', reference: 'r' }); }
  catch (e) { initErr = e; }
  check('a refused transaction says why', Boolean(initErr) && /Invalid contract code/.test(initErr.message));
  check('and which contract and host it tried',
    /7059707855/.test(initErr.message) && /sandbox\.monnify\.com/.test(initErr.message),
    initErr && initErr.message);

  // =========================================================================
  console.log('\nverifying a payment');
  // =========================================================================
  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: {
      requestSuccessful: true,
      responseBody: {
        paymentStatus: 'PAID',
        transactionReference: 'MNFY|20260101|0001',
        paymentReference: 'profitna-abc-1',
        amountPaid: 10000,
        currencyCode: 'NGN',
        paymentMethod: 'CARD',
        paidOn: '2026-01-01T10:00:00.000Z',
        customer: { email: 'owner@mideops.ng', name: 'Tosin' },
        cardDetails: { cardToken: 'MNFY_8BA4740A8ED449E7BE404335977193AC', last4: '4081', expMonth: '09', expYear: '2030', cardType: 'VISA' }
      }
    }
  };

  const v = await monnify.verify('MNFY|20260101|0001', 'owner@mideops.ng');
  check('the reference is URL-encoded into the path',
    calls[1].url.includes(encodeURIComponent('MNFY|20260101|0001')),
    'a raw pipe would break the URL');
  check('amount comes back in naira, undivided', v.amount === 10000,
    'Monnify does not use kobo — got ' + (v && v.amount));
  check('the card token lands in authorizationCode',
    v.authorizationCode === 'MNFY_8BA4740A8ED449E7BE404335977193AC',
    'so the scheduler can charge it without knowing which processor it came from');
  check('the card is readable back', v.card && v.card.last4 === '4081' && v.card.exp === '09/30');
  check('brand is taken from cardType', v.card.brand === 'VISA');
  check('provider names itself', v.provider === 'monnify');

  // Shape parity with Paystack is what lets subscription.js stay unaware.
  const paystackKeys = ['provider', 'customerId', 'authorizationCode', 'reference', 'amount',
    'currency', 'channel', 'paidAt', 'card'];
  check('returns the same fields paystack.verify does',
    paystackKeys.every((k) => k in v), paystackKeys.filter((k) => !(k in v)).join(','));

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: { requestSuccessful: true, responseBody: { paymentStatus: 'PENDING', amountPaid: 0 } }
  };
  check('an unpaid transaction verifies as nothing', (await monnify.verify('MNFY|x')) === null);

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: { requestSuccessful: true, responseBody: { paymentStatus: 'PARTIALLY_PAID', amountPaid: 10 } }
  };
  check('a part payment is not a payment', (await monnify.verify('MNFY|part')) === null);

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: {
      requestSuccessful: true,
      responseBody: { paymentStatus: 'PAID', amountPaid: 10000, customer: { email: 'someone@else.ng' } }
    }
  };
  check('a payment made by another email is refused',
    (await monnify.verify('MNFY|y', 'owner@mideops.ng')) === null,
    'stops one account activating on another account’s receipt');

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: {
      requestSuccessful: true,
      responseBody: { paymentStatus: 'PAID', amountPaid: 10000, customer: { email: 'Owner@Mideops.NG' } }
    }
  };
  check('email matching ignores case',
    (await monnify.verify('MNFY|z', 'owner@mideops.ng')) !== null);

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/api/v2/transactions/'] = {
    json: { requestSuccessful: true, responseBody: { paymentStatus: 'PAID', amountPaid: 5000, cardDetails: {} } }
  };
  const noToken = await monnify.verify('MNFY|notoken');
  check('a payment without tokenisation still verifies',
    noToken !== null && noToken.authorizationCode === null,
    'they have paid; it just will not auto-renew');

  // =========================================================================
  console.log('\ncharging a stored card');
  // =========================================================================
  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/cards/charge-card-token'] = {
    json: { requestSuccessful: true, responseBody: { status: 'PAID', transactionReference: 'MNFY|r1' } }
  };

  const charged = await monnify.chargeAuthorization({
    authorizationCode: 'MNFY_TOKEN', email: 'owner@mideops.ng', name: 'Mideops', amountNaira: 10000, reference: 'profitna-1-2'
  });
  const sent = calls.find((c) => c.url.includes('charge-card-token')).body;
  check('the charge succeeds', charged.ok === true);
  check('amount is sent in naira', sent.amount === 10000, 'sent ' + sent.amount);
  check('the token is sent as cardToken', sent.cardToken === 'MNFY_TOKEN');
  check('contract code and api key are included',
    sent.contractCode === ENV.MONNIFY_CONTRACT_CODE && sent.apiKey === ENV.MONNIFY_API_KEY,
    'charge-card-token rejects the call without both');
  check('our reference is passed through', sent.paymentReference === 'profitna-1-2');
  check('currency is NGN', sent.currencyCode === 'NGN');
  check('no card number is ever sent from this server',
    !JSON.stringify(sent).match(/\b\d{13,19}\b/) && !('cvv' in sent) && !('pan' in sent));

  reset();
  handlers['/api/v1/auth/login'] = LOGIN_OK;
  handlers['/cards/charge-card-token'] = {
    json: { requestSuccessful: true, responseBody: { status: 'FAILED' }, responseMessage: 'Insufficient funds' }
  };
  const declined = await monnify.chargeAuthorization({
    authorizationCode: 'MNFY_TOKEN', email: 'a@b.ng', amountNaira: 10000, reference: 'r'
  });
  check('a decline is not a success', declined.ok === false);
  check('and the reason is readable where the caller looks for it',
    declined.body.message === 'Insufficient funds');

  // =========================================================================
  console.log('\nwebhook signatures');
  // =========================================================================
  reset();
  withMonnify();
  const raw = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { amountPaid: 10000 } }));
  const good = crypto.createHmac('sha512', ENV.MONNIFY_SECRET_KEY).update(raw).digest('hex');

  check('a correctly signed body is accepted', monnify.verifyWebhook(raw, good) === true);
  check('a tampered body is rejected',
    monnify.verifyWebhook(Buffer.from(raw.toString().replace('10000', '1')), good) === false,
    'this is what stops a forged "they paid" notice');
  check('a wrong signature is rejected', monnify.verifyWebhook(raw, 'deadbeef') === false);
  check('a missing signature is rejected', monnify.verifyWebhook(raw, undefined) === false);
  check('a signature of the wrong length does not throw',
    monnify.verifyWebhook(raw, good.slice(0, 20)) === false,
    'timingSafeEqual needs equal lengths');

  withoutMonnify();
  check('no keys means no webhook is trusted', monnify.verifyWebhook(raw, good) === false);
  withMonnify();

  // =========================================================================
  console.log('\nchoosing a provider');
  // =========================================================================
  reset();
  const realPaystackConfigured = paystack.configured;

  withoutMonnify();
  delete process.env.PAYMENT_PROVIDER;
  paystack.configured = () => false;
  check('nothing configured means no gateway', gateway.configured() === false);
  check('and a charge through it refuses loudly', (() => {
    try { gateway.required(); return false; } catch (e) { return /No payment provider/.test(e.message); }
  })());

  paystack.configured = () => true;
  check('paystack alone is picked', gateway.name() === 'paystack');

  withMonnify();
  check('monnify wins when both are set', gateway.name() === 'monnify',
    'a deployment that has just moved over still has the old keys lying around');

  process.env.PAYMENT_PROVIDER = 'paystack';
  check('PAYMENT_PROVIDER forces the choice back', gateway.name() === 'paystack');

  process.env.PAYMENT_PROVIDER = 'monnify';
  check('and forces it forward again', gateway.name() === 'monnify');

  process.env.PAYMENT_PROVIDER = 'stripe';
  check('an unknown provider is not quietly ignored', gateway.configured() === false,
    'billing through the wrong processor silently would be worse than not billing');

  process.env.PAYMENT_PROVIDER = 'monnify';
  withoutMonnify();
  check('a named provider that is not set up is not configured', gateway.configured() === false);

  delete process.env.PAYMENT_PROVIDER;
  paystack.configured = realPaystackConfigured;
  global.fetch = realFetch;

  // =========================================================================
  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed\n');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
})().catch((err) => { console.error(err); process.exit(1); });
