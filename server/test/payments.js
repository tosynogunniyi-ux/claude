// Taking money in, and giving it back.
//   npm run test:payments
//
// Starts the real app in this process on an ephemeral port, and a fake
// Paystack and Monnify on another. The fake gateways matter more than they
// sound: the questions worth asking here are what happens when a provider
// says "pending", when it reports a smaller amount than we asked for, when a
// webhook is replayed, and when it is forged — and none of those can be
// arranged against a real gateway.
//
// Everything runs against the real database, because the invariants being
// checked are enforced by deferred constraint triggers and a test with a
// stubbed database would be testing the stub.

require('dotenv').config();

// A key of its own, set before anything requires the crypto module, so this
// run cannot read or write credentials belonging to a real deployment.
const ORIGINAL_KEY = process.env.CREDENTIALS_KEY;
delete process.env.CREDENTIALS_KEY;

const http = require('http');
const crypto = require('crypto');
const { pool, one, many, query, tx } = require('../src/db');
const money = require('../src/money');
const vault = require('../src/crypto');
const providers = require('../src/payments/providers');
const merchant = require('../src/payments/merchant');
const receipts = require('../src/payments/receipts');
const creditNotes = require('../src/payments/credit-notes');
const collect = require('../src/payments/collect');
const reports = require('../src/accounting/reports');
const backfill = require('../src/accounting/backfill');
const { seedChartOfAccounts } = require('../src/defaults');
const accounts = require('../src/accounting/accounts');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const made = [];

const PAYSTACK_SECRET = 'sk_test_' + 'a'.repeat(32);
const PAYSTACK_PUBLIC = 'pk_test_' + 'b'.repeat(32);
const MONNIFY_KEY = 'MK_TEST_' + 'C'.repeat(10);
const MONNIFY_SECRET = 'MN_SECRET_' + 'd'.repeat(20);
const MONNIFY_CONTRACT = '1234567890';

// ----------------------------------------------------------- the fake gateways
//
// One server answering both providers' shapes. `plan` is what it will say
// about a reference the next time it is asked, so a test can arrange "the
// provider has not seen this yet" and "the provider says ₦50,000 arrived"
// without touching the code under test.

const plan = new Map();
const seen = { initialise: [], verify: [] };

function gatewayHandler(req, res) {
  const url = new URL(req.url, 'http://gateway.test');
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // ---- Paystack
    if (url.pathname === '/transaction' ) {
      if (req.headers.authorization !== 'Bearer ' + PAYSTACK_SECRET) {
        return send(401, { status: false, message: 'Invalid key' });
      }
      return send(200, { status: true, data: [] });
    }
    if (url.pathname === '/transaction/initialize') {
      seen.initialise.push({ provider: 'paystack', body });
      return send(200, {
        status: true,
        data: {
          authorization_url: 'https://checkout.test/paystack/' + body.reference,
          reference: body.reference,
          access_code: 'ac_' + body.reference
        }
      });
    }
    if (url.pathname.startsWith('/transaction/verify/')) {
      const ref = decodeURIComponent(url.pathname.split('/').pop());
      seen.verify.push({ provider: 'paystack', ref });
      const p = plan.get(ref);
      if (!p) return send(404, { status: false, message: 'Transaction not found' });
      if (p.state === 'pending') {
        return send(200, { status: true, data: { reference: ref, status: 'pending', amount: 0 } });
      }
      if (p.state === 'abandoned') {
        return send(200, { status: true, data: { reference: ref, status: 'abandoned', amount: 0 } });
      }
      return send(200, {
        status: true,
        data: {
          id: 99000 + ref.length,
          reference: ref,
          status: p.state === 'paid' ? 'success' : 'failed',
          amount: p.amountKobo,
          fees: p.feeKobo || 0,
          currency: 'NGN',
          channel: 'card',
          paid_at: p.paidAt || new Date().toISOString(),
          gateway_response: 'Successful',
          customer: { email: p.email || 'payer@example.ng', first_name: 'Ada', last_name: 'Nwosu' }
        }
      });
    }

    // ---- Monnify
    if (url.pathname === '/api/v1/auth/login') {
      const expected = 'Basic ' + Buffer.from(MONNIFY_KEY + ':' + MONNIFY_SECRET).toString('base64');
      if (req.headers.authorization !== expected) {
        return send(200, { requestSuccessful: false, responseMessage: 'Invalid credentials' });
      }
      return send(200, {
        requestSuccessful: true,
        responseBody: { accessToken: 'monnify-token', expiresIn: 3600 }
      });
    }
    if (url.pathname === '/api/v1/merchant/transactions/init-transaction') {
      seen.initialise.push({ provider: 'monnify', body });
      return send(200, {
        requestSuccessful: true,
        responseBody: {
          checkoutUrl: 'https://checkout.test/monnify/' + body.paymentReference,
          transactionReference: 'MNFY|' + body.paymentReference,
          paymentReference: body.paymentReference
        }
      });
    }
    if (url.pathname.startsWith('/api/v2/transactions/')) {
      const ref = decodeURIComponent(url.pathname.split('/').pop());
      seen.verify.push({ provider: 'monnify', ref });
      const p = plan.get(ref) || plan.get(String(ref).replace(/^MNFY\|/, ''));
      if (!p) return send(200, { requestSuccessful: false, responseMessage: 'Transaction not found' });
      return send(200, {
        requestSuccessful: true,
        responseBody: {
          paymentStatus: p.state === 'paid' ? 'PAID' : p.state === 'pending' ? 'PENDING' : 'FAILED',
          paymentReference: ref,
          transactionReference: 'MNFY|' + ref,
          // Monnify counts in NAIRA, as a decimal. This is the wire.
          amountPaid: money.toNaira(p.amountKobo),
          settlementAmount: money.toNaira(p.amountKobo - (p.feeKobo || 0)),
          currencyCode: 'NGN',
          paymentMethod: 'ACCOUNT_TRANSFER',
          paidOn: p.paidAt || new Date().toISOString(),
          customer: { email: p.email || 'payer@example.ng', name: 'Ada Nwosu' }
        }
      });
    }

    return send(404, { status: false, message: 'no such endpoint' });
  });
}

// --------------------------------------------------------------- HTTP client

function clientFor(base) {
  let cookie = null;
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign(
        body ? { 'Content-Type': 'application/json' } : {},
        cookie ? { cookie } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
  };
}

// --------------------------------------------------------------- fixtures

async function makeOrg(tag, vat) {
  const org = await one(
    'INSERT INTO organizations (name, vat_registered, vat_rate) VALUES ($1, $2, 7.5) RETURNING *',
    ['Payments ' + tag, vat !== false]
  );
  made.push(org.id);
  await tx(async (client) => {
    await seedChartOfAccounts(client, org.id, 'sme');
    await accounts.ensure(client, org.id);
  });
  return org;
}

async function makeInvoice(orgId, { number, totalKobo, due, party = 'Ada Nwosu', net, tax }) {
  return tx(async (client) => {
    const netKobo = net === undefined ? totalKobo : net;
    const taxKobo = tax === undefined ? totalKobo - netKobo : tax;
    const client_row = (await client.query(
      `INSERT INTO clients (organization_id, name, email) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING *`,
      [orgId, party, 'payer@example.ng']
    )).rows[0] || (await client.query(
      'SELECT * FROM clients WHERE organization_id = $1 AND name = $2', [orgId, party]
    )).rows[0];

    const invoice = (await client.query(
      `INSERT INTO invoices (organization_id, number, client_id, client_name, issue_date, due_date,
              total, subtotal_kobo, tax_kobo, total_kobo, base_status, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sent',now()) RETURNING *`,
      [orgId, number, client_row.id, party, daysAgo(30), due || today(),
        money.toNaira(totalKobo), netKobo, taxKobo, totalKobo]
    )).rows[0];

    await client.query(
      `INSERT INTO invoice_lines (invoice_id, organization_id, position, description, qty_milli,
              unit_price_kobo, tax_treatment, tax_bp, net_kobo, tax_kobo, total_kobo)
       VALUES ($1,$2,0,$3,1000,$4,$5,$6,$7,$8,$9)`,
      [invoice.id, orgId, 'Consulting', netKobo,
        taxKobo ? 'standard' : 'no_vat', taxKobo ? 750 : 0, netKobo, taxKobo, totalKobo]
    );

    const post = require('../src/accounting/post');
    await post.invoiceIssued(client, {
      orgId, invoice,
      lines: [{ description: 'Consulting', net: netKobo }],
      totals: { net: netKobo, tax: taxKobo, total: totalKobo }
    });
    return invoice;
  });
}

async function balanceOf(orgId, code) {
  const row = await one(
    `SELECT COALESCE(SUM(l.debit_kobo - l.credit_kobo), 0) AS n
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.organization_id = $1 AND a.code = $2`,
    [orgId, code]
  );
  return Number(row.n);
}

async function outstandingOf(orgId, invoiceId) {
  const owed = require('../src/invoicing/outstanding');
  const row = await one(
    `SELECT ${owed.outstanding('i')} AS n FROM invoices i
      WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, invoiceId]
  );
  return Number(row.n);
}

// ------------------------------------------------------------------- the run

(async () => {
  const gateway = http.createServer(gatewayHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const gatewayBase = 'http://127.0.0.1:' + gateway.address().port;

  // The providers are pointed at the fake, in this process, so nothing
  // test-only has to exist in the shipped configuration.
  providers.ALL.paystack.base = () => gatewayBase;
  providers.ALL.monnify.base = () => gatewayBase;

  const app = require('../src/index.js');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const finish = async (code) => {
    for (const id of made) await query('DELETE FROM organizations WHERE id = $1', [id]).catch(() => {});
    await new Promise((r) => server.close(r));
    await new Promise((r) => gateway.close(r));
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIALS_KEY;
    else process.env.CREDENTIALS_KEY = ORIGINAL_KEY;
    await pool.end().catch(() => {});
    process.exit(code);
  };

  try {
    // =====================================================================
    console.log('\nstoring a tenant\'s credentials when there is nowhere safe to put them');

    const orgA = await makeOrg('A');

    check('without CREDENTIALS_KEY the module says so rather than guessing',
      vault.configured() === false && vault.warnings().length === 1,
      'warnings: ' + vault.warnings().length);

    let refused = null;
    try {
      await merchant.save(orgA.id, 'paystack', { publicKey: PAYSTACK_PUBLIC, secretKey: PAYSTACK_SECRET });
    } catch (err) { refused = err; }
    check('saving a secret is refused, not stored in the clear',
      refused && refused.code === 'NO_CREDENTIALS_KEY' && refused.status === 503,
      refused ? refused.code : 'it was accepted');
    check('and the refusal says exactly what to set',
      refused && /CREDENTIALS_KEY/.test(refused.message) && /openssl rand/.test(refused.message));

    const stored = await one('SELECT COUNT(*)::int n FROM merchant_accounts WHERE organization_id = $1', [orgA.id]);
    check('nothing was written', stored.n === 0, 'rows: ' + stored.n);

    const offState = await merchant.collectionState(orgA.id);
    check('and the feature reports itself off with the reason',
      offState.ready === false && offState.reason === 'storage' && /CREDENTIALS_KEY/.test(offState.requirement));

    // =====================================================================
    console.log('\nand when there is');
    process.env.CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');

    const saved = await merchant.save(orgA.id, 'paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: '  "' + PAYSTACK_SECRET + '"  '
    });
    check('the quotes and spaces a paste adds are stripped',
      vault.decrypt(saved.account.secret_cipher,
        { organizationId: orgA.id, provider: 'paystack' }) === PAYSTACK_SECRET);
    check('the column holds ciphertext, not the key',
      saved.account.secret_cipher.startsWith('v1.') &&
      !saved.account.secret_cipher.includes(PAYSTACK_SECRET));
    check('the mask keeps the prefix and the last four and nothing else',
      saved.account.secret_hint === 'sk_test_' + '•'.repeat(8) + PAYSTACK_SECRET.slice(-4),
      saved.account.secret_hint);
    check('saving does not mark it usable',
      saved.account.active === false && saved.account.verified_at === null);
    check('each tenant gets its own webhook path, 256 bits of it',
      /^[0-9a-f]{64}$/.test(saved.account.webhook_token));

    const orgB = await makeOrg('B');
    await merchant.save(orgB.id, 'paystack', {
      publicKey: PAYSTACK_PUBLIC, secretKey: 'sk_test_' + 'z'.repeat(32)
    });
    let crossed = null;
    try {
      vault.decrypt(saved.account.secret_cipher, { organizationId: orgB.id, provider: 'paystack' });
    } catch (err) { crossed = err; }
    check('one tenant\'s ciphertext will not decrypt as another\'s',
      crossed && crossed.code === 'CREDENTIAL_UNREADABLE',
      'the organisation id is authenticated data, not just a column');

    let crossedProvider = null;
    try {
      vault.decrypt(saved.account.secret_cipher, { organizationId: orgA.id, provider: 'monnify' });
    } catch (err) { crossedProvider = err; }
    check('nor as a different provider\'s on the same tenant',
      crossedProvider && crossedProvider.code === 'CREDENTIAL_UNREADABLE');

    // =====================================================================
    console.log('\nwhat the settings screen is allowed to see');

    const sme = clientFor(BASE);
    const stamp = Date.now();
    const signedUp = await sme('POST', '/api/auth/signup', {
      name: 'Tosin Balogun', org: 'Payments Live ' + stamp,
      email: 'pay-' + stamp + '@mideops.ng', password: 'payments-test-pass-1',
      book: 'sme', cycle: 'monthly', users: 1
    });
    check('a real account can be created to drive the routes', signedUp.status === 201,
      'status ' + signedUp.status);
    const orgId = signedUp.body.session.orgId;
    made.push(orgId);
    await query('UPDATE organizations SET vat_registered = true, vat_rate = 7.5 WHERE id = $1', [orgId]);

    const putIn = await sme('PUT', '/api/orgs/' + orgId + '/payment-accounts/paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: PAYSTACK_SECRET
    });
    check('an admin can connect their own Paystack account', putIn.status === 200, 'status ' + putIn.status);
    check('and is told that saving is not the same as working',
      /Press Test/.test(putIn.body.next || ''), putIn.body.next);

    const describe = await sme('GET', '/api/orgs/' + orgId + '/payment-accounts');
    check('no endpoint returns the secret key',
      !JSON.stringify(describe.body).includes(PAYSTACK_SECRET),
      'the whole response was searched for it');
    check('the public key is returned, because it is public',
      JSON.stringify(describe.body).includes(PAYSTACK_PUBLIC));
    const paystackRow = describe.body.providers.find((p) => p.name === 'paystack');
    check('the state is a sentence, not a flag to interpret',
      paystackRow.state === 'unverified', paystackRow.state);
    check('the webhook URL to paste in the dashboard is shown',
      /\/api\/pay\/hook\/[0-9a-f]{64}$/.test(paystackRow.webhookUrl || ''), paystackRow.webhookUrl);

    const hookUrl = paystackRow.webhookUrl;
    const hookToken = hookUrl.split('/').pop();

    const beforeTest = await sme('POST', '/api/orgs/' + orgId + '/payment-accounts/paystack/active',
      { active: true });
    check('it cannot be switched on before the provider has accepted it',
      beforeTest.status === 409 && /Test the credentials first/.test(beforeTest.body.error),
      'status ' + beforeTest.status);

    const tested = await sme('POST', '/api/orgs/' + orgId + '/payment-accounts/paystack/test');
    check('testing against the provider turns it on', tested.status === 200 && tested.body.ok === true,
      'status ' + tested.status + ' ' + JSON.stringify(tested.body.error || ''));
    check('and records which mode the provider said the key was in',
      tested.body.mode === 'test', tested.body.mode);

    const badKey = await sme('PUT', '/api/orgs/' + orgId + '/payment-accounts/paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: 'sk_test_' + 'q'.repeat(32)
    });
    check('changing the key un-proves it rather than keeping the tick',
      badKey.status === 200 &&
      badKey.body.accounts.providers.find((p) => p.name === 'paystack').state === 'unverified');

    const failedTest = await sme('POST', '/api/orgs/' + orgId + '/payment-accounts/paystack/test');
    check('a key the provider refuses is reported as 424, not 500',
      failedTest.status === 424 && /refused that secret key/.test(failedTest.body.error),
      'status ' + failedTest.status);
    const afterFail = await one(
      'SELECT last_error, active, verified_at FROM merchant_accounts WHERE organization_id = $1', [orgId]);
    check('the failure is kept against the account and it stays off',
      afterFail.active === false && afterFail.verified_at === null && /refused/.test(afterFail.last_error || ''));

    // Back to the working key for the rest.
    await sme('PUT', '/api/orgs/' + orgId + '/payment-accounts/paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: PAYSTACK_SECRET
    });
    await sme('POST', '/api/orgs/' + orgId + '/payment-accounts/paystack/test');

    const masked = (await sme('GET', '/api/orgs/' + orgId + '/payment-accounts'))
      .body.providers.find((p) => p.name === 'paystack');
    const sentBack = await sme('PUT', '/api/orgs/' + orgId + '/payment-accounts/paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: masked.secretHint
    });
    check('sending the mask back does not overwrite the working key',
      sentBack.status === 200 &&
      (await merchant.credentials(orgId, 'paystack')).creds.secretKey === PAYSTACK_SECRET,
      'a settings form that round-trips its own placeholder must not wipe a credential');

    console.log('\nmismatches said out loud before a card is involved');
    const liveInTest = await merchant.save(orgB.id, 'paystack', {
      environment: 'test', publicKey: 'pk_live_' + 'x'.repeat(32), secretKey: 'sk_live_' + 'y'.repeat(32)
    });
    check('a live key in a test slot is called out',
      liveInTest.notes.some((n) => /Real cards will be charged/.test(n)), JSON.stringify(liveInTest.notes));
    const halfLive = await merchant.save(orgB.id, 'monnify', {
      environment: 'live', publicKey: 'MK_TEST_ABCDEFGHIJ', secretKey: 'secret', contractCode: '1'
    });
    check('a test Monnify key on a live account is called out',
      halfLive.notes.some((n) => /Live mode will reject it/.test(n)), JSON.stringify(halfLive.notes));
    const orgNoContract = await makeOrg('NC');
    let noContract = null;
    try {
      await merchant.save(orgNoContract.id, 'monnify', {
        environment: 'test', publicKey: MONNIFY_KEY, secretKey: MONNIFY_SECRET, contractCode: ''
      });
    } catch (err) { noContract = err; }
    check('Monnify without a contract code is refused, naming the field',
      noContract && noContract.status === 400 && /contract code/.test(noContract.message),
      noContract ? noContract.message : 'it was accepted');

    // =====================================================================
    console.log('\none receipt across several invoices');

    const inv1 = await makeInvoice(orgA.id, { number: 'INV-A1', totalKobo: 10000000, net: 10000000, tax: 0 });
    const inv2 = await makeInvoice(orgA.id, { number: 'INV-A2', totalKobo: 5000000, net: 5000000, tax: 0 });
    const inv3 = await makeInvoice(orgA.id, { number: 'INV-A3', totalKobo: 2500000, net: 2500000, tax: 0 });

    const bank = await one(
      `INSERT INTO bank_accounts (organization_id, name, bank_name, opening_balance, opening_date, is_primary)
       VALUES ($1,'Main','GTBank',0,$2,true) RETURNING *`, [orgA.id, daysAgo(400)]
    );
    await tx((client) => accounts.ensureBankAccount(client, orgA.id, bank.id));

    const combined = await tx((client) => receipts.record(client, {
      orgId: orgA.id, party: 'Ada Nwosu', receivedOn: today(),
      amountKobo: 17500000, method: 'bank_transfer', bankAccountId: bank.id,
      allocations: [
        { invoiceId: inv1.id, amountKobo: 10000000 },
        { invoiceId: inv2.id, amountKobo: 5000000 },
        { invoiceId: inv3.id, amountKobo: 2500000 }
      ]
    }));
    check('one receipt settles three invoices',
      combined.allocations.length === 3 &&
      (await outstandingOf(orgA.id, inv1.id)) === 0 &&
      (await outstandingOf(orgA.id, inv2.id)) === 0 &&
      (await outstandingOf(orgA.id, inv3.id)) === 0);
    check('it gets a receipt number the customer can be given',
      /^RCP-\d{4}-\d{5}$/.test(combined.receipt.receipt_number), combined.receipt.receipt_number);
    check('the receivable fell by the whole amount',
      (await balanceOf(orgA.id, '1100')) === 0, String(await balanceOf(orgA.id, '1100')));
    check('and the bank rose by it',
      (await balanceOf(orgA.id, (await one('SELECT code FROM accounts WHERE id = $1', [
        (await one('SELECT account_id FROM bank_accounts WHERE id = $1', [bank.id])).account_id
      ])).code)) === 17500000);

    const cashRows = await many(
      'SELECT * FROM transactions WHERE organization_id = $1 AND ref_customer_payment_id = $2',
      [orgA.id, combined.receipt.id]
    );
    check('exactly one cash-book row, so a bank statement can be matched to it',
      cashRows.length === 1 && Number(cashRows[0].amount) === 175000 &&
      cashRows[0].bank_account_id === bank.id,
      cashRows.length + ' rows');
    check('and it names the invoices it was for',
      /INV-A1, INV-A2, INV-A3/.test(cashRows[0].description), cashRows[0].description);

    const tb1 = await reports.trialBalance(orgA.id);
    check('the trial balance still balances', tb1.balanced, 'off by ' + tb1.difference);

    console.log('\nwhat it refuses');
    const inv4 = await makeInvoice(orgA.id, { number: 'INV-A4', totalKobo: 3000000, net: 3000000, tax: 0 });

    let over = null;
    try {
      await tx((client) => receipts.record(client, {
        orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 5000000,
        allocations: [{ invoiceId: inv4.id, amountKobo: 5000000 }]
      }));
    } catch (err) { over = err; }
    check('an invoice cannot be allocated more than it owes',
      over && over.status === 400 && /only has ₦30,000.00 outstanding/.test(over.message),
      over ? over.message : 'it was accepted');
    check('and the refusal tells you what to do with the excess',
      over && /on account/.test(over.message));

    let tooMuch = null;
    try {
      await tx((client) => receipts.record(client, {
        orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 1000000,
        allocations: [{ invoiceId: inv4.id, amountKobo: 1500000 }]
      }));
    } catch (err) { tooMuch = err; }
    check('allocations cannot exceed the money received',
      tooMuch && tooMuch.status === 400 && /more than the ₦10,000.00 received/.test(tooMuch.message),
      tooMuch ? tooMuch.message : 'it was accepted');

    const draft = await one(
      `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total,
              subtotal_kobo, total_kobo, base_status)
       VALUES ($1,'DRAFT-X','Ada Nwosu',$2,$2,100,10000,10000,'draft') RETURNING *`,
      [orgA.id, today()]
    );
    let draftErr = null;
    try {
      await tx((client) => receipts.record(client, {
        orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 10000,
        allocations: [{ invoiceId: draft.id, amountKobo: 10000 }]
      }));
    } catch (err) { draftErr = err; }
    check('a draft invoice cannot be paid',
      draftErr && draftErr.status === 409 && /still a draft/.test(draftErr.message),
      draftErr ? draftErr.message : 'it was accepted');

    console.log('\nand what the database refuses even if the code does not ask');
    let triggerErr = null;
    try {
      await tx(async (client) => {
        await client.query(
          `INSERT INTO invoice_payments (invoice_id, organization_id, customer_payment_id, amount_kobo, date)
           VALUES ($1,$2,$3,$4,$5)`,
          [inv4.id, orgA.id, combined.receipt.id, 50000000, today()]
        );
      });
    } catch (err) { triggerErr = err; }
    check('an allocation beyond the receipt is rejected by the constraint trigger',
      triggerErr && /exceed the .* kobo received/.test(triggerErr.message),
      triggerErr ? triggerErr.message.slice(0, 90) : 'it was accepted');

    // =====================================================================
    console.log('\nmoney received before there is an invoice for it');

    const advance = await tx((client) => receipts.record(client, {
      orgId: orgA.id, party: 'Chinedu Okafor', amountKobo: 8000000,
      method: 'bank_transfer', bankAccountId: bank.id, allocations: []
    }));
    check('a receipt with nothing to put it against is still a receipt',
      advance.receipt.id && advance.allocations.length === 0);
    check('it is a liability, not revenue — Customer Deposits, not Sales',
      (await balanceOf(orgA.id, '2300')) === -8000000, String(await balanceOf(orgA.id, '2300')));
    check('the receivable is untouched by it',
      (await balanceOf(orgA.id, '1100')) === 3000000, String(await balanceOf(orgA.id, '1100')));
    const tb2 = await reports.trialBalance(orgA.id);
    check('and the books still balance', tb2.balanced, 'off by ' + tb2.difference);

    const invAdv = await makeInvoice(orgA.id, {
      number: 'INV-A5', totalKobo: 6000000, net: 6000000, tax: 0, party: 'Chinedu Okafor'
    });
    const applied = await tx((client) => receipts.allocate(client, {
      orgId: orgA.id, receiptId: advance.receipt.id,
      allocations: [{ invoiceId: invAdv.id, amountKobo: 6000000 }]
    }));
    check('allocating it later settles the invoice',
      applied.allocations.length === 1 && (await outstandingOf(orgA.id, invAdv.id)) === 0);
    check('the deposit moves out of the liability, not out of the bank again',
      (await balanceOf(orgA.id, '2300')) === -2000000, String(await balanceOf(orgA.id, '2300')));
    const tb3 = await reports.trialBalance(orgA.id);
    check('and the books still balance after the move', tb3.balanced, 'off by ' + tb3.difference);

    let noneLeft = null;
    try {
      await tx((client) => receipts.allocate(client, {
        orgId: orgA.id, receiptId: advance.receipt.id,
        allocations: [{ invoiceId: inv4.id, amountKobo: 2500000 }]
      }));
    } catch (err) { noneLeft = err; }
    check('and only what is left of it can be allocated',
      noneLeft && noneLeft.status === 400 && /more than the ₦20,000.00 received/.test(noneLeft.message),
      noneLeft ? noneLeft.message : 'it was accepted');

    console.log('\nthe background pass does not post any of it twice');
    const entriesBefore = Number((await one(
      'SELECT COUNT(*)::int n FROM journal_entries WHERE organization_id = $1', [orgA.id])).n);
    await backfill.run({ organizationId: orgA.id });
    const entriesAfter = Number((await one(
      'SELECT COUNT(*)::int n FROM journal_entries WHERE organization_id = $1', [orgA.id])).n);
    check('a backfill over receipted invoices posts nothing new',
      entriesAfter === entriesBefore, entriesBefore + ' -> ' + entriesAfter);
    check('and nothing is reported as outstanding to post',
      (await backfill.pending(orgA.id)).length === 0);
    const tb4 = await reports.trialBalance(orgA.id);
    check('the ledger still balances after it', tb4.balanced, 'off by ' + tb4.difference);
    const ageing1 = await reports.receivablesAgeing(orgA.id);
    check('and receivables still reconcile with the ledger', ageing1.reconciles,
      'off by ' + ageing1.difference);
    check('with the money held in advance reported separately',
      ageing1.heldInAdvance === 2000000, String(ageing1.heldInAdvance));

    // =====================================================================
    console.log('\nreversing a receipt');

    const toReverse = await makeInvoice(orgA.id, { number: 'INV-A6', totalKobo: 4000000, net: 4000000, tax: 0 });
    const doomed = await tx((client) => receipts.record(client, {
      orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 4000000,
      method: 'cash', allocations: [{ invoiceId: toReverse.id, amountKobo: 4000000 }]
    }));
    check('paid, to begin with', (await outstandingOf(orgA.id, toReverse.id)) === 0);

    const reversed = await tx((client) => receipts.reverse(client, {
      orgId: orgA.id, receiptId: doomed.receipt.id, reason: 'cheque bounced'
    }));
    check('a reversal does not delete the receipt',
      reversed.status === 'reversed' && reversed.receipt_number === doomed.receipt.receipt_number);
    check('the invoice is owed again',
      (await outstandingOf(orgA.id, toReverse.id)) === 4000000,
      String(await outstandingOf(orgA.id, toReverse.id)));
    check('the reason is kept on the record', /cheque bounced/.test(reversed.notes || ''));
    const tb5 = await reports.trialBalance(orgA.id);
    check('and the books balance after the reversal', tb5.balanced, 'off by ' + tb5.difference);
    const mirror = await one(
      `SELECT COUNT(*)::int n FROM journal_entries
        WHERE organization_id = $1 AND reversal_of IS NOT NULL`, [orgA.id]);
    check('the correction is a mirror entry, so both stay in the record', mirror.n >= 1);

    let twice = null;
    try {
      await tx((client) => receipts.reverse(client, { orgId: orgA.id, receiptId: doomed.receipt.id }));
    } catch (err) { twice = err; }
    check('and it cannot be reversed twice', twice && twice.status === 409);

    // =====================================================================
    console.log('\na closed period');
    await query('UPDATE organizations SET books_locked_through = $2 WHERE id = $1',
      [orgA.id, today()]);
    let locked = null;
    try {
      await tx((client) => receipts.record(client, {
        orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 100000, allocations: []
      }));
    } catch (err) { locked = err; }
    check('nothing can be received into books that are closed',
      locked && locked.code === 'PERIOD_LOCKED', locked ? locked.code : 'it was accepted');
    await query('UPDATE organizations SET books_locked_through = NULL WHERE id = $1', [orgA.id]);

    // =====================================================================
    console.log('\ncollecting online, through the tenant\'s own account');

    const payable = await makeInvoice(orgA.id, { number: 'INV-A7', totalKobo: 12500000, net: 12500000, tax: 0 });
    await merchant.save(orgA.id, 'paystack', {
      environment: 'test', publicKey: PAYSTACK_PUBLIC, secretKey: PAYSTACK_SECRET
    });
    await merchant.verifyAccount(orgA.id, 'paystack');

    const link = await collect.createLink(orgA.id, {
      invoiceId: payable.id, email: 'payer@example.ng', returnBase: BASE + '/api/pay/return'
    });
    check('a hosted checkout URL comes back', /^https:\/\/checkout\.test\//.test(link.url), link.url);
    // Not "does not contain A7". Twenty-four random hex characters contain
    // any given pair about one time in eleven, so that assertion failed for
    // nobody's fault roughly every eleventh run — the worst kind of test,
    // because it teaches people to re-run until it passes.
    //
    // The real claim is that the reference is not derived from the invoice,
    // and the way to show that is to generate a thousand and watch them all
    // differ, and to check none carries the invoice number itself.
    const refs = new Set();
    for (let i = 0; i < 1000; i++) refs.add(collect.newReference());
    check('the reference is random, not the invoice number',
      /^PI-[0-9A-F]{24}$/.test(link.reference) &&
      !link.reference.includes(payable.number) &&
      refs.size === 1000,
      link.reference + ' / ' + refs.size + ' distinct of 1000');
    const initialise = seen.initialise[seen.initialise.length - 1];
    check('the tenant\'s own secret key authorised it, not Profitna\'s',
      initialise.provider === 'paystack' && initialise.body.amount === 12500000,
      'amount on the wire: ' + initialise.body.amount);
    check('and the return URL carries the reference, so the page can ask',
      String(initialise.body.metadata.profitna_reference) === link.reference);

    console.log('\na redirect is not a payment');
    plan.set(link.reference, { state: 'pending', amountKobo: 0 });
    const optimistic = await fetch(BASE + '/api/pay/return/' + link.reference + '?status=success&trxref=x');
    const optimisticHtml = await optimistic.text();
    check('the page says not confirmed even though the URL says success',
      optimistic.status === 200 && /Payment not confirmed yet/.test(optimisticHtml),
      optimistic.status + ' ' + optimisticHtml.slice(0, 80));
    check('and no receipt was created on the strength of a query string',
      Number((await one(
        'SELECT COUNT(*)::int n FROM customer_payments WHERE organization_id = $1 AND source = $2',
        [orgA.id, 'gateway'])).n) === 0);

    // A customer who pressed back, or a redirect that beat the gateway's own
    // record of the transaction. Neither is a failure, and calling it one
    // would be a lie in the direction that costs the customer money.
    plan.delete(link.reference);
    const noRecord = await (await fetch(BASE + '/api/pay/return/' + link.reference)).text();
    check('a provider with no record of it yet is reported as not confirmed, not as failed',
      /Payment not confirmed yet/.test(noRecord), noRecord.slice(0, 60));

    plan.set(link.reference, { state: 'abandoned', amountKobo: 0 });
    const abandoned = await (await fetch(BASE + '/api/pay/return/' + link.reference)).text();
    check('an abandoned attempt is reported as not gone through',
      /did not go through/.test(abandoned), abandoned.slice(0, 60));
    check('and still created nothing',
      Number((await one(
        'SELECT COUNT(*)::int n FROM customer_payments WHERE organization_id = $1 AND source = $2',
        [orgA.id, 'gateway'])).n) === 0);

    console.log('\nwhat the provider actually says');
    // The provider reports a smaller amount than the link asked for.
    plan.set(link.reference, { state: 'paid', amountKobo: 5000000, feeKobo: 75000 });
    const landed = await fetch(BASE + '/api/pay/return/' + link.reference);
    const landedHtml = await landed.text();
    check('a confirmed payment is recorded and the page says so',
      /Payment received/.test(landedHtml), landedHtml.slice(0, 120));
    const gatewayReceipt = await one(
      `SELECT * FROM customer_payments WHERE organization_id = $1 AND source = 'gateway'`, [orgA.id]);
    check('the amount recorded is the provider\'s, not the one we asked for',
      Number(gatewayReceipt.amount_kobo) === 5000000, String(gatewayReceipt.amount_kobo));
    check('so the invoice is part-paid, not settled',
      (await outstandingOf(orgA.id, payable.id)) === 7500000,
      String(await outstandingOf(orgA.id, payable.id)));
    check('the processor\'s fee is recorded against the receipt',
      Number(gatewayReceipt.fee_kobo) === 75000);
    check('the money is in the gateway, not the bank',
      (await balanceOf(orgA.id, '1300')) === 5000000, String(await balanceOf(orgA.id, '1300')));
    const transitRow = await one(
      'SELECT * FROM transactions WHERE organization_id = $1 AND ref_customer_payment_id = $2',
      [orgA.id, gatewayReceipt.id]);
    check('and the cash-book row carries no bank account while it is in transit',
      transitRow && transitRow.bank_account_id === null);
    const tb6 = await reports.trialBalance(orgA.id);
    check('the books balance with money in transit', tb6.balanced, 'off by ' + tb6.difference);

    console.log('\nasking twice');
    const again = await fetch(BASE + '/api/pay/return/' + link.reference);
    check('a refreshed return page does not create a second receipt',
      again.status === 200 &&
      Number((await one(
        `SELECT COUNT(*)::int n FROM customer_payments WHERE organization_id = $1 AND source = 'gateway'`,
        [orgA.id])).n) === 1);
    const pollJson = await (await fetch(BASE + '/api/pay/status/' + link.reference)).json();
    check('and a poll returns the same receipt rather than a new one',
      pollJson.status === 'paid' && pollJson.receipt === gatewayReceipt.receipt_number);

    console.log('\nsettling it into the bank');
    const settled = await tx((client) => receipts.settle(client, {
      orgId: orgA.id, receiptId: gatewayReceipt.id, bankAccountId: bank.id, feeKobo: 75000
    }));
    check('the clearing account empties',
      (await balanceOf(orgA.id, '1300')) === 0, String(await balanceOf(orgA.id, '1300')));
    check('the fee lands in Gateway Processing Fees, not as a discount to the customer',
      (await balanceOf(orgA.id, '5900')) === 75000, String(await balanceOf(orgA.id, '5900')));
    check('and the cash-book row can now be matched to a statement',
      (await one('SELECT bank_account_id FROM transactions WHERE ref_customer_payment_id = $1',
        [gatewayReceipt.id])).bank_account_id === bank.id);
    check('the receipt is marked settled', settled.settled_at !== null);
    const tb7 = await reports.trialBalance(orgA.id);
    check('and the books balance after settlement', tb7.balanced, 'off by ' + tb7.difference);

    let twiceSettled = null;
    try {
      await tx((client) => receipts.settle(client, { orgId: orgA.id, receiptId: gatewayReceipt.id }));
    } catch (err) { twiceSettled = err; }
    check('settling twice is refused', twiceSettled && twiceSettled.status === 409);

    // =====================================================================
    console.log('\nwebhooks');

    const hookInvoice = await makeInvoice(orgId, { number: 'INV-W1', totalKobo: 9000000, net: 9000000, tax: 0 });
    const hookLink = await collect.createLink(orgId, {
      invoiceId: hookInvoice.id, email: 'payer@example.ng', returnBase: BASE + '/api/pay/return'
    });
    plan.set(hookLink.reference, { state: 'paid', amountKobo: 9000000, feeKobo: 135000 });

    const event = JSON.stringify({ event: 'charge.success', data: { reference: hookLink.reference, amount: 9000000 } });
    const sign = (body, secret) => crypto.createHmac('sha512', secret).update(body).digest('hex');

    const unknownEndpoint = await fetch(BASE + '/api/pay/hook/' + 'f'.repeat(64), {
      method: 'POST', headers: { 'x-paystack-signature': sign(event, PAYSTACK_SECRET) }, body: event
    });
    check('an unknown webhook token is a plain 404', unknownEndpoint.status === 404);

    const forged = await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(event, 'the-wrong-secret') }, body: event
    });
    check('a forged signature is refused', forged.status === 401, 'status ' + forged.status);
    check('and nothing was recorded from its body',
      Number((await one(
        `SELECT COUNT(*)::int n FROM customer_payments WHERE organization_id = $1`, [orgId])).n) === 0);

    const genuine = await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(event, PAYSTACK_SECRET) }, body: event
    });
    const genuineBody = await genuine.json();
    check('a correctly signed event is accepted',
      genuine.status === 200 && genuineBody.status === 'paid',
      genuine.status + ' ' + JSON.stringify(genuineBody));
    check('and the invoice is settled',
      (await outstandingOf(orgId, hookInvoice.id)) === 0,
      String(await outstandingOf(orgId, hookInvoice.id)));

    const replayed = await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(event, PAYSTACK_SECRET) }, body: event
    });
    check('a replayed webhook is accepted and changes nothing',
      replayed.status === 200 &&
      Number((await one(
        `SELECT COUNT(*)::int n FROM customer_payments WHERE organization_id = $1`, [orgId])).n) === 1,
      'one receipt, however many times the provider retries');
    check('and the invoice is not credited twice',
      Number((await one(
        'SELECT COALESCE(SUM(amount_kobo),0) AS n FROM invoice_payments WHERE invoice_id = $1',
        [hookInvoice.id])).n) === 9000000);

    console.log('\na lying payload');
    const liar = JSON.stringify({
      event: 'charge.success',
      data: { reference: hookLink.reference, amount: 100000000, status: 'success' }
    });
    await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(liar, PAYSTACK_SECRET) }, body: liar
    });
    check('an amount in a signed payload is still not believed',
      Number((await one(
        'SELECT amount_kobo FROM customer_payments WHERE organization_id = $1', [orgId])).amount_kobo) === 9000000,
      'the figure comes from the verify call, never from the event');

    const notOurs = JSON.stringify({ event: 'charge.success', data: { reference: 'PI-SOMEBODYELSE' } });
    const strayRes = await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(notOurs, PAYSTACK_SECRET) }, body: notOurs
    });
    check('a signed event about a payment we did not issue is accepted and ignored',
      strayRes.status === 200 && (await strayRes.json()).status === 'not-ours');

    const otherOrgRef = link.reference;
    const crossOrg = JSON.stringify({ event: 'charge.success', data: { reference: otherOrgRef } });
    const crossRes = await fetch(BASE + '/api/pay/hook/' + hookToken, {
      method: 'POST', headers: { 'x-paystack-signature': sign(crossOrg, PAYSTACK_SECRET) }, body: crossOrg
    });
    check('one tenant\'s webhook cannot be used to confirm another tenant\'s payment',
      crossRes.status === 200 && (await crossRes.json()).status === 'not-ours',
      'the token in the path decides the organisation, and the lookup is scoped to it');

    console.log('\nMonnify, which counts in naira');
    const monnifyOrg = await makeOrg('M');
    await merchant.save(monnifyOrg.id, 'monnify', {
      environment: 'test', publicKey: MONNIFY_KEY, secretKey: MONNIFY_SECRET, contractCode: MONNIFY_CONTRACT
    });
    const monnifyVerified = await merchant.verifyAccount(monnifyOrg.id, 'monnify');
    check('Monnify credentials can be proved too', monnifyVerified.ok === true);

    const awkward = await makeInvoice(monnifyOrg.id, {
      number: 'INV-M1', totalKobo: 1000005, net: 1000005, tax: 0
    });
    const monnifyLink = await collect.createLink(monnifyOrg.id, {
      invoiceId: awkward.id, email: 'payer@example.ng', returnBase: BASE + '/api/pay/return'
    });
    const monnifySent = seen.initialise[seen.initialise.length - 1];
    check('the amount on the wire is naira, not kobo',
      monnifySent.provider === 'monnify' && monnifySent.body.amount === 10000.05,
      'sent ' + monnifySent.body.amount + ' — a stray ×100 here charges a hundred times over');
    check('and the tenant\'s own contract code went with it',
      monnifySent.body.contractCode === MONNIFY_CONTRACT);

    plan.set(monnifyLink.reference, { state: 'paid', amountKobo: 1000005, feeKobo: 0 });
    const monnifyToken = (await one(
      'SELECT webhook_token FROM merchant_accounts WHERE organization_id = $1', [monnifyOrg.id])).webhook_token;
    const monnifyEvent = JSON.stringify({
      eventType: 'SUCCESSFUL_TRANSACTION',
      eventData: { paymentReference: monnifyLink.reference, transactionReference: 'MNFY|' + monnifyLink.reference }
    });
    const monnifyHook = await fetch(BASE + '/api/pay/hook/' + monnifyToken, {
      method: 'POST',
      headers: { 'monnify-signature': sign(monnifyEvent, MONNIFY_SECRET) },
      body: monnifyEvent
    });
    check('a Monnify event is accepted', monnifyHook.status === 200, 'status ' + monnifyHook.status);
    const awkwardReceipt = await one(
      'SELECT * FROM customer_payments WHERE organization_id = $1', [monnifyOrg.id]);
    check('₦10,000.05 survives the round trip as 1000005 kobo',
      Number(awkwardReceipt.amount_kobo) === 1000005, String(awkwardReceipt.amount_kobo));
    check('and the invoice is exactly settled, not a kobo out',
      (await outstandingOf(monnifyOrg.id, awkward.id)) === 0,
      String(await outstandingOf(monnifyOrg.id, awkward.id)));
    const tbM = await reports.trialBalance(monnifyOrg.id);
    check('the books balance on the awkward figure', tbM.balanced, 'off by ' + tbM.difference);

    // =====================================================================
    console.log('\ncredit notes');

    const creditOrg = await makeOrg('C');
    const toCredit = await makeInvoice(creditOrg.id, {
      number: 'INV-C1', totalKobo: 10750000, net: 10000000, tax: 750000
    });
    check('the invoice raised VAT to begin with',
      (await balanceOf(creditOrg.id, '2100')) === -750000, String(await balanceOf(creditOrg.id, '2100')));

    const draftNote = await tx((client) => creditNotes.fromInvoice(client, creditOrg.id, toCredit.id));
    check('a credit note can be built from the invoice it corrects',
      draftNote.creditable === 10750000 && draftNote.lines.length === 1, JSON.stringify(draftNote.creditable));
    check('and its lines come back in the shape the builder posts',
      draftNote.lines[0].qty === 1 && draftNote.lines[0].unitPrice === 100000 &&
      draftNote.lines[0].taxTreatment === 'standard',
      JSON.stringify(draftNote.lines[0]));

    const issued = await tx((client) => creditNotes.issue(client, {
      orgId: creditOrg.id, invoiceId: toCredit.id, reason: 'Two days not delivered',
      lines: [{ description: 'Consulting', qty: 1, unitPrice: 20000, taxTreatment: 'standard', taxRate: 7.5 }]
    }));
    check('issuing it allocates a number in its own series',
      /^CRN-\d{4}-\d{5}$/.test(issued.note.number), issued.note.number);
    check('revenue is given back', (await balanceOf(creditOrg.id, '1100')) === 8600000,
      String(await balanceOf(creditOrg.id, '1100')));
    check('and the VAT with it, because it was never the business\'s money',
      (await balanceOf(creditOrg.id, '2100')) === -600000, String(await balanceOf(creditOrg.id, '2100')));
    check('the invoice owes less without anybody having paid',
      (await outstandingOf(creditOrg.id, toCredit.id)) === 8600000,
      String(await outstandingOf(creditOrg.id, toCredit.id)));
    check('it is applied to the invoice it corrects, straight away',
      issued.applied.length === 1 && issued.applied[0].amount === 2150000);
    const tbC = await reports.trialBalance(creditOrg.id);
    check('and the books balance', tbC.balanced, 'off by ' + tbC.difference);

    const ageingC = await reports.receivablesAgeing(creditOrg.id);
    check('receivables reconcile with the ledger after a credit note', ageingC.reconciles,
      'off by ' + ageingC.difference);

    console.log('\nwhat a credit note is not allowed to be');
    let tooBig = null;
    try {
      await tx((client) => creditNotes.issue(client, {
        orgId: creditOrg.id, invoiceId: toCredit.id,
        lines: [{ description: 'Everything', qty: 1, unitPrice: 500000, taxTreatment: 'no_vat' }]
      }));
    } catch (err) { tooBig = err; }
    check('a credit note bigger than what is left of the invoice is refused',
      tooBig && tooBig.status === 400 && /left to credit/.test(tooBig.message),
      tooBig ? tooBig.message : 'it was accepted');

    const standalone = await tx((client) => creditNotes.issue(client, {
      orgId: creditOrg.id, party: 'Ada Nwosu', reason: 'Goodwill',
      lines: [{ description: 'Goodwill credit', qty: 1, unitPrice: 5000, taxTreatment: 'no_vat' }]
    }));
    check('a credit note can stand alone, unapplied',
      standalone.applied.length === 0 && Number(standalone.note.total_kobo) === 500000);
    const ageingU = await reports.receivablesAgeing(creditOrg.id);
    check('an unapplied credit is reported as such rather than breaking the check',
      ageingU.unappliedCredits === 500000 && ageingU.reconciles,
      'unapplied ' + ageingU.unappliedCredits + ', off by ' + ageingU.difference);

    let wrongCustomer = null;
    const otherParty = await makeInvoice(creditOrg.id, {
      number: 'INV-C2', totalKobo: 2000000, net: 2000000, tax: 0, party: 'Bolade Ltd'
    });
    try {
      await tx((client) => creditNotes.apply(client, {
        orgId: creditOrg.id, noteId: standalone.note.id, invoiceId: otherParty.id, amountKobo: 100000
      }));
    } catch (err) { wrongCustomer = err; }
    check('a credit note cannot be applied to another customer\'s invoice',
      wrongCustomer && wrongCustomer.status === 400 && /different customer/.test(wrongCustomer.message),
      wrongCustomer ? wrongCustomer.message : 'it was accepted');

    let overApplied = null;
    try {
      await tx((client) => creditNotes.apply(client, {
        orgId: creditOrg.id, noteId: standalone.note.id, invoiceId: toCredit.id, amountKobo: 900000
      }));
    } catch (err) { overApplied = err; }
    check('and no more of it can be applied than it is worth',
      overApplied && overApplied.status === 400 && /Only ₦5,000.00/.test(overApplied.message),
      overApplied ? overApplied.message : 'it was accepted');

    console.log('\nvoiding one');
    const voided = await tx((client) => creditNotes.voidNote(client, {
      orgId: creditOrg.id, noteId: issued.note.id, reason: 'raised in error'
    }));
    check('the note is marked void, not deleted',
      voided.status === 'void' && voided.voided_at !== null);
    check('the invoice is owed in full again',
      (await outstandingOf(creditOrg.id, toCredit.id)) === 10750000,
      String(await outstandingOf(creditOrg.id, toCredit.id)));
    check('the VAT comes back too',
      (await balanceOf(creditOrg.id, '2100')) === -750000, String(await balanceOf(creditOrg.id, '2100')));
    const tbV = await reports.trialBalance(creditOrg.id);
    check('and the books balance after the void', tbV.balanced, 'off by ' + tbV.difference);

    console.log('\nwithholding tax has no place on a credit note');
    await query('UPDATE organizations SET default_wht_bp = 500 WHERE id = $1', [creditOrg.id]);
    const whtNote = await tx((client) => creditNotes.issue(client, {
      orgId: creditOrg.id, party: 'Ada Nwosu',
      lines: [{ description: 'Credit', qty: 1, unitPrice: 10000, taxTreatment: 'no_vat' }]
    }));
    check('a 5% default WHT does not reduce a credit note',
      Number(whtNote.note.total_kobo) === 1000000 && whtNote.totals.wht === 0,
      'total ' + whtNote.note.total_kobo + ', wht ' + whtNote.totals.wht);

    // =====================================================================
    console.log('\none tenant cannot reach another\'s money');

    const theirInvoice = await makeInvoice(orgB.id, { number: 'INV-B1', totalKobo: 5000000, net: 5000000, tax: 0 });
    let crossAlloc = null;
    try {
      await tx((client) => receipts.record(client, {
        orgId: orgA.id, party: 'Ada Nwosu', amountKobo: 5000000,
        allocations: [{ invoiceId: theirInvoice.id, amountKobo: 5000000 }]
      }));
    } catch (err) { crossAlloc = err; }
    check('an invoice belonging to another organisation is simply not there',
      crossAlloc && crossAlloc.status === 404, crossAlloc ? crossAlloc.message : 'it was accepted');

    const theirReceipt = await sme('GET', '/api/orgs/' + orgId + '/payments/' + combined.receipt.id);
    check('nor is another organisation\'s receipt', theirReceipt.status === 404,
      'status ' + theirReceipt.status);

    const theirLink = await sme('POST', '/api/orgs/' + orgId + '/payment-links/' + link.reference + '/check');
    check('nor a payment reference issued by another organisation',
      theirLink.status === 404, 'status ' + theirLink.status);

    const viewerBlocked = await sme('PUT', '/api/orgs/' + orgA.id + '/payment-accounts/paystack', {
      publicKey: 'pk_test_x', secretKey: 'sk_test_x'
    });
    check('and credentials cannot be written into books the caller is not in',
      viewerBlocked.status === 403 || viewerBlocked.status === 404,
      'status ' + viewerBlocked.status);

    // =====================================================================
    console.log('\nthe routes a person actually uses');

    const form = await sme('GET', '/api/orgs/' + orgId + '/payments/new');
    check('the payment form arrives in one call',
      form.status === 200 && Array.isArray(form.body.openInvoices) &&
      Array.isArray(form.body.bankAccounts) && form.body.collection.ready === true,
      'status ' + form.status);
    check('and says plainly that the money goes to the tenant',
      /Paystack/.test(form.body.collection.message), form.body.collection.message);

    const owing = await makeInvoice(orgId, { number: 'INV-W2', totalKobo: 7000000, net: 7000000, tax: 0 });
    const olderOwing = await makeInvoice(orgId, {
      number: 'INV-W3', totalKobo: 3000000, net: 3000000, tax: 0, due: daysAgo(60)
    });

    const suggested = await sme('GET', '/api/orgs/' + orgId +
      '/payments/suggest?party=Ada%20Nwosu&amount=50000');
    check('oldest first is offered as a suggestion',
      suggested.status === 200 && suggested.body.invoices[0].number === 'INV-W3' &&
      suggested.body.allocated === 5000000,
      JSON.stringify(suggested.body.invoices.map((i) => [i.number, i.suggested])));

    const recorded = await sme('POST', '/api/orgs/' + orgId + '/payments', {
      party: 'Ada Nwosu', amount: '50,000.00', method: 'bank_transfer', date: today(),
      allocations: [
        { invoiceId: olderOwing.id, amountKobo: 3000000 },
        { invoiceId: owing.id, amountKobo: 2000000 }
      ]
    });
    check('a typed amount with a comma and a currency habit is read correctly',
      recorded.status === 201 && recorded.body.receipt.amount === 5000000,
      'status ' + recorded.status + ' ' + JSON.stringify(recorded.body.error || recorded.body.receipt));
    check('and the allocations come back with it',
      recorded.body.allocations.length === 2);

    const listed = await sme('GET', '/api/orgs/' + orgId + '/payments?limit=50');
    check('the receipts list is paged and summarised server-side',
      listed.status === 200 && listed.body.total >= 2 && listed.body.received > 0,
      JSON.stringify({ total: listed.body.total, received: listed.body.received }));

    const unallocatedOnly = await sme('GET', '/api/orgs/' + orgId + '/payments?status=unallocated');
    check('and can be filtered to money not yet put against anything',
      unallocatedOnly.status === 200 && unallocatedOnly.body.payments.every((p) => p.unallocated > 0));

    const receivables = await sme('GET', '/api/orgs/' + orgId + '/receivables');
    check('the receivables screen arrives in one call',
      receivables.status === 200 && receivables.body.ageing && receivables.body.byCustomer,
      'status ' + receivables.status);
    check('and says in one line whether it agrees with the ledger',
      receivables.body.ageing.reconciles === true &&
      /agree with the general ledger/.test(receivables.body.note),
      receivables.body.note);

    const cnRoute = await sme('POST', '/api/orgs/' + orgId + '/credit-notes', {
      invoiceId: owing.id, reason: 'Short delivery',
      lines: [{ description: 'Credit', qty: 1, unitPrice: 10000, taxTreatment: 'no_vat' }]
    });
    check('a credit note can be issued over HTTP',
      cnRoute.status === 201 && cnRoute.body.note.total === 1000000,
      'status ' + cnRoute.status + ' ' + JSON.stringify(cnRoute.body.error || ''));
    check('and it is applied to the invoice it names',
      cnRoute.body.applications.length === 1 && cnRoute.body.note.unapplied === 0);

    const cnList = await sme('GET', '/api/orgs/' + orgId + '/credit-notes');
    check('credit notes list with the credit still outstanding',
      cnList.status === 200 && cnList.body.creditNotes.length >= 1);

    const linkRoute = await sme('POST', '/api/orgs/' + orgId + '/invoices/' + owing.id + '/payment-link', {
      email: 'payer@example.ng'
    });
    check('a payment link can be created over HTTP',
      linkRoute.status === 201 && /^https:\/\/checkout\.test\//.test(linkRoute.body.url),
      'status ' + linkRoute.status + ' ' + JSON.stringify(linkRoute.body.error || ''));
    check('and the tenant is told whether it takes real money',
      /test link/i.test(linkRoute.body.note), linkRoute.body.note);

    const anonymous = await makeInvoice(orgId, {
      number: 'INV-W4', totalKobo: 1500000, net: 1500000, tax: 0, party: 'Walk-in Customer'
    });
    await query('UPDATE clients SET email = NULL WHERE organization_id = $1 AND name = $2',
      [orgId, 'Walk-in Customer']);
    const noEmail = await sme('POST', '/api/orgs/' + orgId + '/invoices/' + anonymous.id + '/payment-link', {});
    check('a link for a customer with no email on file says which field both providers need',
      noEmail.status === 400 && /email/.test(noEmail.body.error), noEmail.body.error);

    plan.set(linkRoute.body.reference, { state: 'failed', amountKobo: 0 });
    const checkFailed = await sme('POST', '/api/orgs/' + orgId +
      '/payment-links/' + linkRoute.body.reference + '/check');
    check('a failed payment is reported as failed and creates nothing',
      checkFailed.status === 200 && checkFailed.body.status === 'failed' && !checkFailed.body.receipt,
      JSON.stringify(checkFailed.body));

    const sweptLink = await sme('POST', '/api/orgs/' + orgId + '/invoices/' + owing.id + '/payment-link', {
      email: 'payer@example.ng'
    });
    plan.set(sweptLink.body.reference, { state: 'paid', amountKobo: 1000000 });
    const swept = await sme('POST', '/api/orgs/' + orgId + '/payment-links/sweep');
    check('a sweep picks up a payment whose webhook never arrived',
      swept.status === 200 && swept.body.paid >= 1,
      JSON.stringify(swept.body));

    const health = await (await fetch(BASE + '/api/health')).json();
    check('health says whether credentials can be stored at all',
      health.merchantCredentials === 'encrypted at rest', health.merchantCredentials);

    // =====================================================================
    console.log('\nnothing that was already there changed');

    const legacy = await makeOrg('L');
    const legacyInvoice = await makeInvoice(legacy.id, {
      number: 'INV-L1', totalKobo: 2000000, net: 2000000, tax: 0
    });
    // The old route, writing straight onto the document with no receipt.
    await tx(async (client) => {
      await client.query(
        'INSERT INTO invoice_payments (invoice_id, amount, date, method) VALUES ($1,$2,$3,$4)',
        [legacyInvoice.id, 5000, today(), 'Cash']
      );
    });
    const legacyRow = await one(
      'SELECT * FROM invoice_payments WHERE invoice_id = $1', [legacyInvoice.id]);
    check('a payment written the old way still gets its kobo figure',
      Number(legacyRow.amount_kobo) === 500000, String(legacyRow.amount_kobo));
    check('and its tenant, from the invoice it is against',
      legacyRow.organization_id === legacy.id);
    check('so the invoice reads as part-paid',
      (await outstandingOf(legacy.id, legacyInvoice.id)) === 1500000,
      String(await outstandingOf(legacy.id, legacyInvoice.id)));

    await backfill.run({ organizationId: legacy.id });
    const tbL = await reports.trialBalance(legacy.id);
    check('the backfill still picks up a parentless payment', tbL.balanced && await balanceOf(legacy.id, '1100') === 1500000,
      'receivable ' + await balanceOf(legacy.id, '1100'));

    console.log('\nnothing resembling a card number is ever written down');
    // The hosted checkout means a card is typed into the provider's page and
    // never reaches this server. That is a claim worth checking rather than
    // asserting: every text column on every row this release writes is read
    // back and searched for anything card-shaped.
    const texty = await many(
      `SELECT c.party, c.reference, c.notes, c.provider_reference, c.receipt_number,
              t.description, t.party AS tx_party
         FROM customer_payments c
         LEFT JOIN transactions t ON t.ref_customer_payment_id = c.id`
    );
    const CARDISH = /(?:\d[ -]?){13,19}/;
    const offenders = texty.filter((row) =>
      Object.values(row).some((v) => typeof v === 'string' && CARDISH.test(v)));
    check('no receipt, reference, note or cash-book line holds a card-shaped number',
      offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));

    const cols = await many(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('customer_payments', 'payment_links', 'merchant_accounts')
          AND column_name ~* '(pan|card|cvv|cvc|expiry|exp_month|exp_year)'`
    );
    check('and no column exists that could hold one',
      cols.length === 0, JSON.stringify(cols.map((c) => c.column_name)));

    console.log('');
    if (failures.length) {
      console.log(passed + ' passed, ' + failures.length + ' failed');
      for (const f of failures) console.log('  - ' + f);
      return finish(1);
    }
    console.log(passed + ' passed, 0 failed');
    return finish(0);
  } catch (err) {
    console.error('\n' + (err && err.stack ? err.stack : err));
    return finish(1);
  }
})();
