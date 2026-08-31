// End-to-end check against a running server and a real database.
//   npm start        (in one shell)
//   npm run smoke    (in another)
// Creates two throwaway accounts, exercises every write path, and asserts
// that one organisation can never read another's books.

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';

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

function client() {
  let cookie = null;
  return async function call(method, path, body) {
    const res = await fetch(BASE + path, {
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
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
}

async function signup(call, email, book, org) {
  return call('POST', '/api/auth/signup', {
    name: book === 'church' ? 'Grace Uzoma' : 'Tosin Balogun',
    org,
    email,
    password: 'smoke-test-pass-1',
    book,
    cycle: 'monthly',
    users: 1,
    card: { brand: 'Visa', last4: '4081', exp: '09/29' }
  });
}

(async () => {
  const stamp = Date.now();
  const sme = client();
  const church = client();

  console.log('\nauth');
  const a = await signup(sme, 'smoke-sme-' + stamp + '@mideops.ng', 'sme', 'Mideops Ventures');
  check('signup creates an SME account', a.status === 201 && a.body.session.book === 'sme', 'status ' + a.status);
  const orgA = a.body.session.orgId;

  const b = await signup(church, 'smoke-church-' + stamp + '@gracechapel.ng', 'church', 'Grace Chapel International');
  check('signup creates a church account', b.status === 201 && b.body.session.book === 'church');
  const orgB = b.body.session.orgId;

  const dup = await signup(client(), 'smoke-sme-' + stamp + '@mideops.ng', 'sme', 'Mideops Ventures');
  check('a second signup on the same email is refused', dup.status === 409);

  const badLogin = await client()('POST', '/api/auth/login', {
    email: 'smoke-sme-' + stamp + '@mideops.ng',
    password: 'wrong-password'
  });
  check('a wrong password is refused', badLogin.status === 401);

  console.log('\ntenant isolation');
  const cross = await church('GET', '/api/orgs/' + orgA + '/data');
  check('another organisation reads as not found', cross.status === 404);
  const crossWrite = await church('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'expense', amount: 1000, description: 'should never post', date: '2026-08-01'
  });
  check('another organisation cannot write', crossWrite.status === 404);
  const anon = await client()('GET', '/api/orgs/' + orgA + '/data');
  check('a signed-out caller is refused', anon.status === 401);

  console.log('\nchart of accounts');
  const cat = await sme('POST', '/api/orgs/' + orgA + '/expense-categories', { name: 'Diesel & Generator', pct: 75 });
  check('a new expense account is created', cat.status === 201 && cat.body.pct === 75);
  const again = await sme('POST', '/api/orgs/' + orgA + '/expense-categories', { name: 'diesel & generator', pct: 10 });
  check('a duplicate account reuses the existing one', again.status === 200 && again.body.created === false);
  const pct = await sme('PATCH', '/api/orgs/' + orgA + '/expense-categories/' + encodeURIComponent('Diesel & Generator'), { pct: 40 });
  check('deductibility can be changed', pct.body.pct === 40);

  console.log('\nledger');
  const tx = await sme('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'expense', date: '2026-08-20', amount: '1,250,000',
    category: 'Diesel & Generator', party: 'Mikano', description: 'Generator diesel', method: 'Bank transfer'
  });
  check('a transaction posts', tx.status === 201 && tx.body.tx.amount === 1250000);

  const uncoded = await sme('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'expense', date: '2026-08-21', amount: 46500, category: '',
    party: 'Spectranet Ltd', description: 'Spectranet monthly internet renewal'
  });
  check('an uncoded transaction posts', uncoded.status === 201 && uncoded.body.tx.category === '');

  const coded = await sme('POST', '/api/orgs/' + orgA + '/transactions/categorize');
  check('categorisation codes what it can', coded.status === 200 && coded.body.count >= 1, 'coded ' + coded.body.count);

  console.log('\ninvoices and payments');
  const inv = await sme('POST', '/api/orgs/' + orgA + '/invoices', {
    party: 'Aisha Bello', createContact: true, email: 'aisha@example.ng',
    total: 2000000, issue: '2026-08-01', due: '2026-09-01'
  });
  check('an invoice creates its client too', inv.status === 201 && Boolean(inv.body.contact));
  check('the invoice number uses the INV series', /^INV-\d+$/.test(inv.body.doc.number), inv.body.doc.number);

  const pay = await sme('POST', '/api/orgs/' + orgA + '/invoices/' + inv.body.doc.id + '/payments', { amount: 750000 });
  check('a payment updates the balance', pay.body.doc.paid === 750000);
  check('a payment posts to the cash ledger', pay.body.tx && pay.body.tx.type === 'income');

  const pledge = await church('POST', '/api/orgs/' + orgB + '/invoices', {
    party: 'Deacon Emeka Obi', createContact: true, total: 500000, issue: '2026-08-01', due: '2026-11-01'
  });
  check('church books issue pledges', /^PLG-\d+$/.test(pledge.body.doc.number), pledge.body.doc.number);

  console.log('\ninventory');
  const item = await sme('POST', '/api/orgs/' + orgA + '/inventory', {
    name: 'Solar Inverter 3.5kVA', sku: 'SLR-035', cost: 385000, price: 520000, purchased: 20, reorder: 8
  });
  check('an item is created', item.status === 201);
  const sale = await sme('POST', '/api/orgs/' + orgA + '/inventory/' + item.body.item.id + '/move', { dir: 'sell', qty: 5 });
  check('a sale moves stock and posts income', sale.body.item.sold === 5 && sale.body.tx.amount === 2600000);
  const oversell = await sme('POST', '/api/orgs/' + orgA + '/inventory/' + item.body.item.id + '/move', { dir: 'sell', qty: 500 });
  check('selling more than is held is refused', oversell.status === 400);

  console.log('\nbank statements');
  const imported = await sme('POST', '/api/orgs/' + orgA + '/bank/import', {
    rows: [
      { date: '2026-08-19', type: 'expense', category: 'Utilities', amount: 155000, narration: 'POS/IKEJA ELECTRIC PREPAID TOKEN' },
      { date: '2026-08-18', type: 'income', category: 'Product Sales', amount: 900000, narration: 'TRF FRM HALOGEN RETAIL STORES' }
    ]
  });
  check('an import posts transactions and statement lines', imported.body.tx.length === 2 && imported.body.bank.length === 2);
  check('imported lines come back reconciled', imported.body.bank.every((l) => Boolean(l.matched)));
  const match = await sme('POST', '/api/orgs/' + orgA + '/bank/auto-match');
  check('auto-match runs', match.status === 200);

  console.log('\nsubscription');
  const subs = await sme('PATCH', '/api/orgs/' + orgA + '/subscription', { cycle: 'annual', users: 3 });
  check('cycle and seats update', subs.body.subscription.cycle === 'annual' && subs.body.subscription.users === 3);
  check('the amount follows the seat count', subs.body.subscription.amount === 57000 * 3);
  const overSeat = await sme('PATCH', '/api/orgs/' + orgA + '/subscription', { users: 900 });
  check('seats are capped', overSeat.body.subscription.users === 25);

  console.log('\npersistence');
  const fresh = client();
  const back = await fresh('POST', '/api/auth/login', {
    email: 'smoke-sme-' + stamp + '@mideops.ng', password: 'smoke-test-pass-1'
  });
  check('sign-in works after signup', back.status === 200);
  const data = await fresh('GET', '/api/orgs/' + orgA + '/data');
  const book = data.body.book;
  check('the ledger comes back', book.tx.some((t) => t.description === 'Generator diesel'));
  check('the invoice comes back with its payment', book.inv.some((i) => i.id === inv.body.doc.id && i.paid === 750000));
  check('the new account is on the chart', book.cats.some((c) => c.name === 'Diesel & Generator' && c.pct === 40));
  check('the contact was kept', book.clients.some((c) => c.name === 'Aisha Bello'));

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nsmoke run could not finish: ' + err.message);
  process.exit(1);
});
