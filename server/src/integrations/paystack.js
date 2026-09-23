const crypto = require('crypto');

// Paystack. Card details go from the browser straight to Paystack's SDK — this
// server only ever sees a transaction reference and the reusable
// authorization code that comes back from verifying it.

const API = 'https://api.paystack.co';

function configured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

function headers() {
  return {
    Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
    'Content-Type': 'application/json'
  };
}

// Confirms a completed card authorization and returns what we may store.
async function verify(reference, email) {
  if (!configured() || !reference) return null;

  const res = await fetch(API + '/transaction/verify/' + encodeURIComponent(reference), {
    headers: headers()
  });
  if (!res.ok) return null;
  const body = await res.json();
  const data = body && body.data;
  if (!body.status || !data || data.status !== 'success') return null;
  if (email && data.customer && String(data.customer.email).toLowerCase() !== email) return null;

  const auth = data.authorization || {};
  return {
    provider: 'paystack',
    customerId: data.customer ? String(data.customer.customer_code) : null,
    authorizationCode: auth.authorization_code || null,
    // Kept so the charge appears in the owner's payment history rather than
    // only as a card on file. Paystack works in kobo.
    reference: data.reference || reference,
    amount: Number(data.amount || 0) / 100,
    currency: data.currency || 'NGN',
    channel: data.channel || null,
    paidAt: data.paid_at || data.paidAt || null,
    card: auth.last4
      ? { brand: auth.brand || 'Card', last4: auth.last4, exp: auth.exp_month + '/' + String(auth.exp_year).slice(-2) }
      : null
  };
}

// Charges a stored authorization — what runs when a trial ends or a plan
// renews. Amount is in kobo.
async function chargeAuthorization({ authorizationCode, email, amountNaira, reference }) {
  if (!configured()) throw new Error('PAYSTACK_SECRET_KEY is not set');

  const res = await fetch(API + '/transaction/charge_authorization', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      authorization_code: authorizationCode,
      email,
      amount: Math.round(amountNaira * 100),
      reference
    })
  });
  const body = await res.json();
  return { ok: res.ok && body.status && body.data && body.data.status === 'success', body };
}

// Paystack signs webhooks with HMAC-SHA512 over the raw body.
function verifyWebhook(rawBody, signature) {
  if (!configured() || !signature) return false;
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, verify, chargeAuthorization, verifyWebhook };
