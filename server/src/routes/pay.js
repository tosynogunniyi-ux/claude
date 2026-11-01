// The two public endpoints: where a gateway posts, and where a customer lands.
//
// Both are unauthenticated, because neither caller can hold a session — one is
// a server in Lagos or Dublin, the other is a customer who has never signed
// in to Profitna. So both are built on the assumption that anything reaching
// them is hostile until proved otherwise:
//
//   The webhook is identified by a 256-bit token in its own path and
//   authenticated by an HMAC over its raw body, keyed by the tenant's own
//   secret. Nothing in the payload decides which organisation it is about.
//
//   The return page is given a reference and nothing else. It never reads the
//   query string the gateway appended, never trusts the word "success", and
//   its only action is to ask the provider what actually happened. A customer
//   who edits the URL learns which invoice a random reference was for, which
//   is why the reference is 96 random bits rather than an invoice number.
//
// Neither endpoint can create, change or read anything belonging to another
// organisation, and neither returns a figure that is not about the one
// payment it was asked about.

const express = require('express');
const { one } = require('../db');
const money = require('../money');
const collect = require('../payments/collect');

const router = express.Router();

// ------------------------------------------------------------------ webhook

// express.raw is applied where this is mounted, so req.body is a Buffer. It
// has to be: the signature is an HMAC over the bytes the provider sent, and
// re-serialising a parsed object produces different bytes.
async function hook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const token = String(req.params.token || '');

  // Whichever header this provider signs in. Read from the request rather
  // than decided by the token, so a provider that changes nothing but the
  // header name does not need a deployment.
  const signature = req.get('x-paystack-signature') || req.get('monnify-signature') ||
    req.get('x-monnify-signature') || '';

  try {
    const result = await collect.handleWebhook(token, raw, signature);

    if (!result.ok && result.reason === 'unknown-endpoint') {
      // Nothing is leaked about whether the token was close to a real one.
      return res.status(404).json({ error: 'Not found.' });
    }
    if (!result.ok && result.reason === 'bad-signature') {
      // 401, and nothing is recorded from the body. A provider retrying a
      // genuinely signed event will succeed; a forgery will keep failing.
      console.warn('payment webhook rejected: signature did not match (' + result.provider + ')');
      return res.status(401).json({ error: 'Signature did not match.' });
    }
    if (!result.ok) {
      return res.status(400).json({ error: 'Could not read that event.' });
    }

    // 200 as soon as it is handled, so the provider stops retrying. An event
    // we have no use for is still handled.
    return res.json({ ok: true, status: result.status || result.reason || 'accepted' });
  } catch (err) {
    // A failure here means the provider should try again — this is the one
    // place a 5xx is the right answer, because that is what tells a gateway
    // to retry. The body is not what matters; the status is.
    console.error('payment webhook failed:', err.message);
    return res.status(503).json({ error: 'Could not process that event. Please retry.' });
  }
}

// ------------------------------------------------------------- return page

// A person, in a browser, immediately after paying. They get a sentence about
// what happened and nothing to do: the business's own screen is where the
// receipt lives.
async function returnPage(req, res) {
  const reference = String(req.params.reference || '');

  let state = 'unknown';
  let detail = null;
  try {
    const result = await collect.confirm({ reference, source: 'return' });
    state = result.known ? result.status : 'unknown';
    if (result.known) {
      detail = {
        amount: result.receipt ? Number(result.receipt.amount_kobo) : Number(result.link.amount_kobo),
        receipt: result.receipt ? result.receipt.receipt_number : null,
        invoice: result.link.invoice_id
          ? (await one('SELECT number FROM invoices WHERE id = $1', [result.link.invoice_id]) || {}).number
          : null,
        business: (await one(
          'SELECT name FROM organizations WHERE id = $1', [result.link.organization_id]
        ) || {}).name
      };
    }
  } catch (err) {
    // The provider could not be reached. That is not a failed payment, and
    // saying so would be a lie in the direction that costs the customer
    // money. "We cannot tell yet" is the truth.
    state = 'unconfirmed';
    detail = { error: err.message };
  }

  // 200 whatever the outcome: this is a page for a person, and a 4xx here
  // gets replaced by the proxy's own error page, which tells them nothing.
  res.status(200).type('html').send(page(state, detail));
}

function escape(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COPY = {
  paid: {
    title: 'Payment received',
    tone: '#0f7b4f',
    mark: '✓',
    body: 'Thank you. Your payment has been confirmed by the payment provider and recorded.'
  },
  pending: {
    title: 'Payment not confirmed yet',
    tone: '#9a6a00',
    mark: '…',
    body: 'The payment provider has not confirmed this payment yet. If you have just paid, ' +
      'it may take a moment — reload this page shortly. Nothing has been charged twice.'
  },
  failed: {
    title: 'Payment did not go through',
    tone: '#a4302a',
    mark: '✕',
    body: 'The payment provider reported that this payment was not completed. Nothing has ' +
      'been taken. You can try again from the link you were sent.'
  },
  unconfirmed: {
    title: 'We cannot confirm this yet',
    tone: '#9a6a00',
    mark: '…',
    body: 'We could not reach the payment provider to check this payment. If you paid, your ' +
      'payment is safe with them — reload this page in a minute.'
  },
  unknown: {
    title: 'Nothing to show',
    tone: '#5b6472',
    mark: '?',
    body: 'This payment link is not one we recognise. Check the link you were sent, or ask ' +
      'the business for a new one.'
  }
};

function page(state, detail) {
  const c = COPY[state] || COPY.unknown;
  const rows = [];
  if (detail && detail.business) rows.push(['Paid to', detail.business]);
  if (detail && detail.invoice) rows.push(['Invoice', detail.invoice]);
  if (detail && detail.amount) rows.push(['Amount', money.format(detail.amount)]);
  if (detail && detail.receipt) rows.push(['Receipt', detail.receipt]);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(c.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         padding: 24px; background: #f6f4ef;
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1d2430; }
  .card { background: #fff; border-radius: 16px; padding: 32px 28px; max-width: 420px; width: 100%;
          box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 12px 32px rgba(16,24,40,.08); }
  .mark { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center;
          font-size: 22px; font-weight: 600; color: #fff; background: ${c.tone}; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0 0 10px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: #4b5565; }
  dl { margin: 0; border-top: 1px solid #e8e5dd; padding-top: 14px; }
  div.row { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; }
  dt { color: #6b7483; font-size: 14px; margin: 0; }
  dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
  .foot { margin: 20px 0 0; font-size: 13px; color: #8a9199; }
  @media (prefers-color-scheme: dark) {
    body { background: #14171c; color: #e8eaed; }
    .card { background: #1c2026; box-shadow: none; }
    p { color: #a9b0ba; } dl { border-color: #2a2f37; } dt { color: #8a929d; } .foot { color: #6d747e; }
  }
</style>
</head><body>
  <main class="card">
    <div class="mark" aria-hidden="true">${escape(c.mark)}</div>
    <h1>${escape(c.title)}</h1>
    <p>${escape(c.body)}</p>
    ${rows.length ? '<dl>' + rows.map(([k, v]) =>
    '<div class="row"><dt>' + escape(k) + '</dt><dd>' + escape(v) + '</dd></div>').join('') + '</dl>' : ''}
    <p class="foot">Your card details were entered on the payment provider's own page and were
    never sent to Profitna.</p>
  </main>
</body></html>`;
}

// A reference can be checked without the page, for anything that polls.
router.get('/status/:reference', async (req, res) => {
  try {
    const result = await collect.confirm({ reference: String(req.params.reference), source: 'poll' });
    if (!result.known) return res.status(404).json({ status: 'unknown' });
    res.json({
      status: result.status,
      amount: result.receipt ? Number(result.receipt.amount_kobo) : Number(result.link.amount_kobo),
      receipt: result.receipt ? result.receipt.receipt_number : null
    });
  } catch (err) {
    // 424 rather than 5xx: a gateway we could not reach is something we are
    // deliberately reporting, and the proxy would replace a 5xx body.
    res.status(424).json({ status: 'unconfirmed', error: err.message });
  }
});

router.get('/return/:reference', returnPage);

module.exports = { router, hook, returnPage, page };
