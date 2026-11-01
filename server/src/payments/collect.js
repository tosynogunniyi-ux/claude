// Asking a customer to pay online, and believing the answer only when the
// provider gives it.
//
// The rule that shapes this whole file: **a redirect is not a payment.** A
// customer arriving back at a URL with `?status=success` on it has told us
// nothing — they may have pressed back, they may have edited the address bar,
// the gateway may have redirected optimistically before the card settled. So
// every path here, without exception, ends in a call to the provider's own
// verify endpoint with the tenant's own secret key, and only that call
// creates a receipt.
//
// The second rule: the same payment may be reported many times. A webhook is
// retried, a customer refreshes the return page, a person presses "check
// again". All of them collapse onto one receipt, because the provider's
// reference is unique per organisation in the database and `receipts.record`
// returns the existing row rather than writing a second one.

const crypto = require('crypto');
const { pool, one } = require('../db');
const money = require('../money');
const merchant = require('./merchant');
const receipts = require('./receipts');
const owed = require('../invoicing/outstanding');

// Our reference, not the gateway's. 96 bits of randomness, because this
// string is the only thing the public return page is given — anything
// derived from the invoice number would let a stranger walk a business's
// invoices by incrementing it.
//
// Both providers accept letters, digits and hyphens; neither is given
// anything else.
function newReference() {
  return 'PI-' + crypto.randomBytes(12).toString('hex').toUpperCase();
}

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ------------------------------------------------------------ asking to pay

// A hosted checkout for one invoice. Returns the provider's own URL — the
// card is typed into their page, never ours, so nothing resembling a card
// number can reach this server on any path.
async function createLink(orgId, { invoiceId, amountKobo, email, name, userId, returnBase, provider }) {
  const invoice = await one(
    `SELECT i.*, ${owed.outstanding('i')} AS outstanding, c.email AS client_email
       FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, invoiceId]
  );
  if (!invoice) throw fail(404, 'No such invoice.');
  if (invoice.base_status === 'draft') {
    throw fail(409, 'Issue the invoice before asking for payment.');
  }
  if (invoice.voided_at) throw fail(409, 'That invoice has been voided.');

  const outstanding = Number(invoice.outstanding);
  if (outstanding <= 0) throw fail(409, 'Invoice ' + invoice.number + ' is already settled.');

  const wanted = amountKobo === undefined || amountKobo === null
    ? outstanding : Math.round(Number(amountKobo));
  if (wanted <= 0) throw fail(400, 'Enter how much to collect.');
  if (wanted > outstanding) {
    throw fail(400, 'Invoice ' + invoice.number + ' only has ' + money.format(outstanding) +
      ' outstanding.');
  }

  const payerEmail = String(email || invoice.client_email || '').trim();
  if (!payerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payerEmail)) {
    throw fail(400,
      'Both Paystack and Monnify require the payer\'s email address. Add one to ' +
      invoice.client_name + '\'s record, or enter it here.');
  }

  const connection = await merchant.connection(orgId, provider);
  const reference = newReference();

  // The reference is in the path, so the page the customer lands on knows
  // which payment to ask the provider about — and asking is the only thing
  // that page does. Nothing about its query string is believed.
  const callbackUrl = returnBase
    ? String(returnBase).replace(/\/+$/, '') + '/' + reference
    : undefined;

  const started = await connection.provider.initialise(connection.creds, {
    amountKobo: wanted,
    email: payerEmail,
    name: String(name || invoice.client_name || '').trim() || payerEmail,
    reference,
    callbackUrl,
    description: 'Invoice ' + invoice.number,
    metadata: { invoice: invoice.number, profitna_reference: reference },
    token: connection.token
  });

  const link = await one(
    `INSERT INTO payment_links
       (organization_id, invoice_id, provider, reference, amount_kobo, email, customer_name,
        checkout_url, provider_reference, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [orgId, invoice.id, connection.provider.name, reference, wanted, payerEmail,
      String(name || invoice.client_name || '').trim() || null,
      started.url, started.transactionReference || null, userId || null]
  );

  return {
    link,
    url: started.url,
    reference,
    provider: connection.provider.name,
    environment: connection.account.environment,
    invoice: { id: invoice.id, number: invoice.number, party: invoice.client_name },
    amount: wanted
  };
}

// ------------------------------------------------------- believing the answer

// The only function that turns a gateway payment into a receipt. Everything
// — the return page, the webhook, a person pressing "check again", a
// background sweep — comes through here, so there is one definition of what
// counts as paid and one place idempotency is enforced.
async function confirm({ reference, link, providerName, orgId, source }) {
  const row = link || (reference
    ? await one('SELECT * FROM payment_links WHERE reference = $1', [String(reference)])
    : null);

  if (!row) {
    // A reference we did not issue. Said plainly rather than treated as an
    // error: a webhook about a payment made outside Profitna is not a fault,
    // it is simply not ours.
    return { known: false, status: 'unknown', reference: reference || null };
  }
  if (orgId && row.organization_id !== orgId) {
    throw fail(404, 'No such payment reference.');
  }

  const connection = await merchant.connection(row.organization_id, providerName || row.provider);

  // The provider's own word, asked for with the tenant's own secret key.
  // Nothing before this point is trusted, including the amount.
  let verified;
  try {
    verified = await connection.provider.verify(connection.creds, row.reference, connection.token);
  } catch (err) {
    await pool.query(
      'UPDATE payment_links SET last_checked_at = now(), last_error = $2 WHERE id = $1',
      [row.id, String(err.message).slice(0, 500)]
    );
    throw err;
  }

  if (!verified.found) {
    await pool.query(
      `UPDATE payment_links SET last_checked_at = now(),
              last_error = 'The provider has no record of this payment yet.'
        WHERE id = $1`,
      [row.id]
    );
    return { known: true, status: 'pending', link: row, reference: row.reference };
  }

  if (verified.status !== 'paid') {
    await pool.query(
      `UPDATE payment_links
          SET last_checked_at = now(), last_error = NULL,
              provider_reference = COALESCE($2, provider_reference),
              status = CASE WHEN $3 = 'failed' THEN 'failed' ELSE status END
        WHERE id = $1`,
      [row.id, verified.providerReference || null, verified.status]
    );
    return { known: true, status: verified.status, link: row, reference: row.reference, verified };
  }

  // Paid. The amount recorded is the amount the provider says arrived, not
  // the amount we asked for — a customer who paid less has paid less, and
  // writing down what we wanted would settle an invoice that is still owed.
  const received = Math.round(Number(verified.amountKobo) || 0);
  if (received <= 0) {
    throw fail(424, 'The provider reported this payment as successful but with no amount.');
  }

  const result = await withTransaction(async (client) => {
    const locked = (await client.query(
      'SELECT * FROM payment_links WHERE id = $1 FOR UPDATE', [row.id]
    )).rows[0];

    // Another request got here first, inside the lock.
    if (locked.status === 'paid' && locked.customer_payment_id) {
      const existing = (await client.query(
        'SELECT * FROM customer_payments WHERE id = $1', [locked.customer_payment_id]
      )).rows[0];
      return { receipt: existing, alreadyRecorded: true };
    }

    const org = (await client.query(
      'SELECT book_type FROM organizations WHERE id = $1', [locked.organization_id]
    )).rows[0];

    // Allocated to the invoice the link was for, as far as it will go. A
    // short payment settles part of it; an overpayment — which happens with
    // bank-transfer collection — leaves the remainder as money on account
    // rather than overpaying the invoice.
    const invoice = locked.invoice_id
      ? (await client.query(
        `SELECT i.*, ${owed.outstanding('i')} AS outstanding
           FROM invoices i WHERE i.organization_id = $1 AND i.id = $2 FOR UPDATE OF i`,
        [locked.organization_id, locked.invoice_id]
      )).rows[0]
      : null;

    const allocations = invoice && Number(invoice.outstanding) > 0
      ? [{ invoiceId: invoice.id, amountKobo: Math.min(received, Number(invoice.outstanding)) }]
      : [];

    const recorded = await receipts.record(client, {
      orgId: locked.organization_id,
      bookType: org && org.book_type,
      party: (verified.customer && verified.customer.name) || locked.customer_name ||
        (invoice && invoice.client_name) || locked.email || 'Customer',
      clientId: invoice ? invoice.client_id : null,
      receivedOn: (verified.paidAt && String(verified.paidAt).slice(0, 10)) ||
        new Date().toISOString().slice(0, 10),
      amountKobo: received,
      method: 'card',
      reference: locked.reference,
      notes: 'Paid online through ' + connection.provider.label +
        (verified.channel ? ' (' + verified.channel + ')' : ''),
      allocations,
      source: 'gateway',
      provider: connection.provider.name,
      providerReference: verified.providerReference || verified.reference,
      feeKobo: Math.round(Number(verified.feeKobo) || 0),
      status: 'received'
    });

    await client.query(
      `UPDATE payment_links
          SET status = 'paid', customer_payment_id = $2, provider_reference = $3,
              last_checked_at = now(), last_error = NULL
        WHERE id = $1`,
      [locked.id, recorded.receipt.id, verified.providerReference || verified.reference]
    );

    return recorded;
  });

  return {
    known: true,
    status: 'paid',
    link: row,
    reference: row.reference,
    verified,
    receipt: result.receipt,
    alreadyRecorded: result.alreadyRecorded,
    source: source || 'check'
  };
}

// A transaction of our own rather than db.tx, because this is called from a
// public route and a failure here must leave nothing half-written.
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ webhooks

// A gateway posting an event to a URL containing one tenant's token.
//
// The order matters and is not negotiable: find the account from the token in
// the path, check the signature with that account's secret, and only then
// read the body. Reading an organisation id out of an unauthenticated payload
// and then verifying against that organisation's key lets anybody with a
// webhook URL choose which tenant's secret their forgery is checked against.
async function handleWebhook(token, rawBody, signature) {
  const found = await merchant.byWebhookToken(token);
  if (!found) return { ok: false, reason: 'unknown-endpoint' };

  const provider = require('./providers').get(found.account.provider);
  if (!provider.verifyWebhook(found.creds, rawBody, signature)) {
    return { ok: false, reason: 'bad-signature', provider: provider.name };
  }

  let payload = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable-body', provider: provider.name };
  }

  const reference = provider.eventReference(payload);
  if (!reference) {
    // A signed event we have no use for — a settlement report, a disbursement.
    // Accepted so the provider stops retrying it.
    return { ok: true, reason: 'not-a-payment', provider: provider.name };
  }

  // The reference in the payload may be the gateway's own rather than ours,
  // depending on the provider and the event. Both are looked up, and the
  // verify call that follows uses our reference, which is the one the
  // provider will answer about.
  const link = await one(
    `SELECT * FROM payment_links
      WHERE organization_id = $1 AND (reference = $2 OR provider_reference = $2) LIMIT 1`,
    [found.account.organization_id, String(reference)]
  );
  if (!link) return { ok: true, reason: 'not-ours', provider: provider.name };

  const result = await confirm({
    link,
    providerName: provider.name,
    orgId: found.account.organization_id,
    source: 'webhook'
  });
  return { ok: true, provider: provider.name, status: result.status, reference: link.reference };
}

// Open links that have not been answered about. Run by the caller, not on a
// timer here: a provider's webhook may be mis-registered, and a customer who
// has paid should not stay unpaid on screen because of it.
async function sweep(orgId, { limit = 25 } = {}) {
  const rows = (await pool.query(
    `SELECT * FROM payment_links
      WHERE organization_id = $1 AND status = 'open'
        AND created_at > now() - INTERVAL '7 days'
        AND (last_checked_at IS NULL OR last_checked_at < now() - INTERVAL '2 minutes')
      ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit]
  )).rows;

  const out = { checked: 0, paid: 0, failed: 0, errors: [] };
  for (const link of rows) {
    out.checked++;
    try {
      const result = await confirm({ link, orgId, source: 'sweep' });
      if (result.status === 'paid') out.paid++;
      if (result.status === 'failed') out.failed++;
    } catch (err) {
      // One unreachable gateway must not stop the rest being checked.
      out.errors.push({ reference: link.reference, error: err.message });
    }
  }
  return out;
}

module.exports = { createLink, confirm, handleWebhook, sweep, newReference };
