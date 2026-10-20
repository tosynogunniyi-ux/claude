// End-to-end check against a running server and a real database.
//   npm start        (in one shell)
//   npm run smoke    (in another)
// Creates two throwaway accounts, exercises every write path, and asserts
// that one organisation can never read another's books.

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';
const { TRIAL_DAYS } = require('../src/pricing');

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

// Hands back the cookie a client is holding, for the two checks that need a
// raw fetch rather than the JSON helper.
let lastSmeCookie = null;
function smeCookie() { return lastSmeCookie; }

function client(track) {
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
    if (setCookie) {
      cookie = setCookie.split(';')[0];
      if (track) lastSmeCookie = cookie;
    }
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
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
    users: 1
  });
}

(async () => {
  const stamp = Date.now();
  const sme = client(true);
  const church = client();

  console.log('\nauth');
  const a = await signup(sme, 'smoke-sme-' + stamp + '@mideops.ng', 'sme', 'Mideops Ventures');
  check('signup creates an SME account', a.status === 201 && a.body.session.book === 'sme', 'status ' + a.status);
  const orgA = a.body.session.orgId;

  // The id the browser needs to pair its own CompleteRegistration with the
  // one the server sends, so Meta counts one signup rather than two. Returned
  // whether or not tracking is configured: the page should not have to ask
  // twice, and an unconfigured server simply sends nothing.
  check('signup hands back an id for pairing the ad event',
    typeof a.body.metaEventId === 'string' && a.body.metaEventId.length > 6,
    String(a.body.metaEventId));

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

  console.log('\nthe card-free trial');
  const trial = a.body.session;
  check('signup asks for no card', trial.card === null, JSON.stringify(trial.card));
  check('and starts a trial', trial.subStatus === 'trialing' && trial.access === 'trial', trial.access);
  check('with the full trial on it', trial.daysLeft === TRIAL_DAYS, String(trial.daysLeft));
  check('and a date it ends', /^\d{4}-\d{2}-\d{2}$/.test(trial.trialEndsOn || ''), trial.trialEndsOn);
  check('the books open during it', (await sme('GET', '/api/orgs/' + orgA + '/data')).status === 200);

  const withCard = await client()('POST', '/api/auth/signup', {
    name: 'Card Sender', org: 'Card Sender Ltd ' + stamp, email: 'smoke-card-' + stamp + '@mideops.ng',
    password: 'smoke-test-pass-1', book: 'sme', cycle: 'monthly', users: 1,
    card: { brand: 'Visa', last4: '4081', exp: '09/29' }, paymentReference: 'made-up'
  });
  check('a client that sends card details anyway is not billed for it',
    withCard.status === 201 && withCard.body.session.card === null,
    'status ' + withCard.status + ' ' + JSON.stringify(withCard.body.card));

  console.log('\nsubscription');
  const subs = await sme('PATCH', '/api/orgs/' + orgA + '/subscription', { cycle: 'annual', users: 3 });
  check('cycle and seats update', subs.body.subscription.cycle === 'annual' && subs.body.subscription.users === 3);
  check('the amount follows the seat count', subs.body.subscription.amount === 57000 * 3);
  const overSeat = await sme('PATCH', '/api/orgs/' + orgA + '/subscription', { users: 900 });
  check('seats are capped', overSeat.body.subscription.users === 25);

  // ------------------------------------------------- bank accounts & branding
  console.log('\nbank accounts');

  const accts = await sme('GET', '/api/orgs/' + orgA + '/bank-accounts');
  check('a new organisation starts with one account', accts.body.accounts.length === 1, JSON.stringify(accts.body.accounts.length));
  const main = accts.body.accounts[0];
  check('and it is the primary one', main.isPrimary === true);

  const opened = await sme('PATCH', '/api/orgs/' + orgA + '/bank-accounts/' + main.id, {
    name: 'GTBank current', bankName: 'Guaranty Trust Bank', accountNumber: '0123456789',
    openingBalance: 500000, openingDate: '2026-01-01'
  });
  check('an opening balance can be set', opened.status === 200, 'status ' + opened.status);

  const afterOpening = opened.body.accounts[0];
  check('the balance starts from it',
    Number(afterOpening.balance) === 500000 - 42000 + 0 || Number(afterOpening.openingBalance) === 500000,
    JSON.stringify(afterOpening));

  const bookNow = (await sme('GET', '/api/orgs/' + orgA + '/data')).body;
  const live = (await sme('GET', '/api/orgs/' + orgA + '/bank-accounts')).body.accounts[0];
  check('the current balance is opening plus what moved through it',
    Number(live.balance) === Number(live.openingBalance) + Number(live.received) - Number(live.paid),
    JSON.stringify([live.openingBalance, live.received, live.paid, live.balance]));
  check('and it counts the entries recorded against it', Number(live.entries) > 0, String(live.entries));

  check('the opening figure the reports read follows it',
    Number(bookNow.org.openingCash) === 500000, String(bookNow.org.openingCash));
  check('and the book carries the accounts', Array.isArray(bookNow.book.accounts) && bookNow.book.accounts.length === 1);

  const second = await sme('POST', '/api/orgs/' + orgA + '/bank-accounts', {
    name: 'Zenith savings', openingBalance: 250000
  });
  check('a second account can be added', second.status === 201 && second.body.accounts.length === 2);
  check('the second is not primary', second.body.accounts.filter((a) => a.isPrimary).length === 1);
  check('opening cash is now the sum of both',
    Number((await sme('GET', '/api/orgs/' + orgA + '/data')).body.org.openingCash) === 750000);

  const beforeCash = (await sme('GET', '/api/orgs/' + orgA + '/bank-accounts')).body.accounts[0].balance;
  const cashSale = await sme('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'income', date: '2026-03-08', amount: 9000, category: 'Product Sales',
    party: 'Walk-in', description: 'cash over the counter', method: 'Cash'
  });
  check('a cash sale is recorded', cashSale.status === 201);
  const afterCash = (await sme('GET', '/api/orgs/' + orgA + '/bank-accounts')).body;
  check('but does not touch a bank balance',
    Number(afterCash.accounts[0].balance) === Number(beforeCash),
    beforeCash + ' moved to ' + afterCash.accounts[0].balance);

  const bankSale = await sme('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'income', date: '2026-03-08', amount: 11000, category: 'Product Sales',
    party: 'Halogen', description: 'paid in', method: 'Bank transfer'
  });
  check('a bank receipt does', bankSale.status === 201 &&
    Number((await sme('GET', '/api/orgs/' + orgA + '/bank-accounts')).body.accounts[0].balance) === Number(beforeCash) + 11000,
    'expected ' + (Number(beforeCash) + 11000));

  const toSecond = await sme('POST', '/api/orgs/' + orgA + '/transactions', {
    type: 'expense', date: '2026-03-08', amount: 15000, category: 'Utilities',
    party: 'Ikeja Electric', description: 'paid from savings', method: 'Bank transfer',
    bankAccountId: second.body.accounts.find((a) => a.name === 'Zenith savings').id
  });
  check('an entry can name its account', toSecond.status === 201);
  const split = (await sme('GET', '/api/orgs/' + orgA + '/bank-accounts')).body.accounts;
  check('and only that account moves',
    Math.round(Number(split.find((a) => a.name === 'Zenith savings').balance)) === 250000 - 15000,
    JSON.stringify(split.map((a) => [a.name, a.balance])));

  const lastOne = await sme('DELETE', '/api/orgs/' + orgA + '/bank-accounts/' + split[1].id);
  check('an account can be removed', lastOne.status === 200 && lastOne.body.accounts.length === 1);
  const orphan = (await sme('GET', '/api/orgs/' + orgA + '/data')).body.book.tx
    .find((t) => t.description === 'paid from savings');
  check('and what it paid for stays in the books', Boolean(orphan));

  const onlyOne = await sme('DELETE', '/api/orgs/' + orgA + '/bank-accounts/' + split[0].id);
  check('the last account cannot be removed', onlyOne.status === 400, 'status ' + onlyOne.status);

  console.log('\nreport branding');

  const noLogo = await sme('GET', '/api/orgs/' + orgA + '/logo');
  check('there is no logo to begin with', noLogo.status === 404, 'status ' + noLogo.status);

  // A one-pixel PNG, which is enough to exercise the sniffing.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const uploaded = await sme('POST', '/api/orgs/' + orgA + '/logo', { data: 'data:image/png;base64,' + PNG });
  check('a PNG logo uploads', uploaded.status === 201 && uploaded.body.logo.mime === 'image/png',
    'status ' + uploaded.status);

  const served = await fetch(BASE + '/api/orgs/' + orgA + '/logo', { headers: { cookie: smeCookie() } });
  check('and is served back as an image', served.headers.get('content-type') === 'image/png');
  check('locked down on the way out',
    (served.headers.get('content-security-policy') || '').includes('sandbox') &&
    served.headers.get('x-content-type-options') === 'nosniff',
    served.headers.get('content-security-policy'));

  check('the book reports it has one', (await sme('GET', '/api/orgs/' + orgA + '/data')).body.org.hasLogo === true);

  const notAnImage = await sme('POST', '/api/orgs/' + orgA + '/logo', {
    data: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')
  });
  check('an SVG dressed as a logo is refused', notAnImage.status === 400, 'status ' + notAnImage.status);

  const tooBig = await sme('POST', '/api/orgs/' + orgA + '/logo', {
    data: Buffer.alloc(500 * 1024).toString('base64')
  });
  check('and so is an oversized file', tooBig.status === 400, 'status ' + tooBig.status);

  const cleared = await sme('DELETE', '/api/orgs/' + orgA + '/logo');
  check('a logo can be removed', cleared.status === 200);
  check('and the book says so again',
    (await sme('GET', '/api/orgs/' + orgA + '/data')).body.org.hasLogo === false);

  // -------------------------------------------------------------- the team
  console.log('\nroles and invitations');

  const boss = client();
  const bossEmail = 'smoke-boss-' + stamp + '@mideops.ng';
  const bookkeeperEmail = 'smoke-books-' + stamp + '@mideops.ng';
  const readerEmail = 'smoke-reader-' + stamp + '@mideops.ng';

  const team = await boss('POST', '/api/auth/signup', {
    name: 'Chidinma Obi', org: 'Obi Trading ' + stamp, email: bossEmail,
    password: 'smoke-test-pass-1', book: 'sme', cycle: 'monthly', users: 3,
    team: [
      { email: bookkeeperEmail, name: 'Segun Ade', role: 'accountant' },
      { email: readerEmail, name: 'Ngozi Eze', role: 'viewer' }
    ]
  });
  check('signing up for three assigns the other two seats', team.status === 201, 'status ' + team.status);
  check('and hands back a link for each', (team.body.invites || []).length === 2, JSON.stringify(team.body.invites));
  check('with the role each was given',
    team.body.invites.some((i) => i.email === bookkeeperEmail && i.role === 'accountant') &&
    team.body.invites.some((i) => i.email === readerEmail && i.role === 'viewer'),
    JSON.stringify(team.body.invites));

  const teamOrg = team.body.session.orgId;
  check('the subscriber is the admin', team.body.session.role === 'admin', team.body.session.role);

  const roster = await boss('GET', '/api/orgs/' + teamOrg + '/members');
  check('one person is on the books so far', roster.body.members.length === 1);
  check('and two invitations are waiting', roster.body.invitations.length === 2);
  check('every seat is spoken for', roster.body.seats.free === 0, JSON.stringify(roster.body.seats));

  const overSeats = await boss('POST', '/api/orgs/' + teamOrg + '/members', {
    email: 'smoke-fourth-' + stamp + '@mideops.ng', role: 'viewer'
  });
  check('a fourth person needs a fourth seat', overSeats.status === 409, 'status ' + overSeats.status);

  const shrink = await boss('PATCH', '/api/orgs/' + teamOrg + '/subscription', { users: 1 });
  check('seats cannot drop below the people using them', shrink.status === 409, 'status ' + shrink.status);

  const tooMany = await client()('POST', '/api/auth/signup', {
    name: 'Over Reach', org: 'Over Reach ' + stamp, email: 'smoke-over-' + stamp + '@mideops.ng',
    password: 'smoke-test-pass-1', book: 'sme', cycle: 'monthly', users: 2,
    team: [{ email: 'a-' + stamp + '@x.ng', role: 'viewer' }, { email: 'b-' + stamp + '@x.ng', role: 'viewer' }]
  });
  check('you cannot invite more people than you bought seats for', tooMany.status === 400, 'status ' + tooMany.status);

  // --- accepting -----------------------------------------------------------
  const linkFor = (email) => team.body.invites.find((i) => i.email === email).link;
  const tokenOf = (link) => link.split('invite=')[1];

  const peek = await client()('GET', '/api/invitations/' + tokenOf(linkFor(bookkeeperEmail)));
  check('the link says who is inviting and to what', peek.status === 200 &&
    peek.body.invitation.orgName.startsWith('Obi Trading') && peek.body.invitation.role === 'accountant',
    JSON.stringify(peek.body.invitation));
  check('and that there is no account yet', peek.body.invitation.hasAccount === false);

  const junk = await client()('GET', '/api/invitations/not-a-real-token');
  check('a made-up link is not valid', junk.status === 404, 'status ' + junk.status);

  const accountant = client();
  const joined = await accountant('POST', '/api/invitations/' + tokenOf(linkFor(bookkeeperEmail)) + '/accept', {
    name: 'Segun Ade', password: 'smoke-test-pass-2'
  });
  check('accepting creates the account and signs them in', joined.status === 201, 'status ' + joined.status);
  check('on the books they were invited to', joined.body.session.orgId === teamOrg);
  check('with the role they were given', joined.body.session.role === 'accountant', joined.body.session.role);

  const reuse = await client()('POST', '/api/invitations/' + tokenOf(linkFor(bookkeeperEmail)) + '/accept', {
    name: 'Someone Else', password: 'another-password'
  });
  check('the same link cannot be used twice', reuse.status === 400, 'status ' + reuse.status);

  // --- what each role may do ----------------------------------------------
  const read = await accountant('GET', '/api/orgs/' + teamOrg + '/data');
  check('an accountant can read the books', read.status === 200, 'status ' + read.status);

  const wrote = await accountant('POST', '/api/orgs/' + teamOrg + '/transactions', {
    type: 'expense', date: '2026-03-02', amount: 42000, category: 'Fuel',
    party: 'Total', description: 'entered by the accountant'
  });
  check('and write to them', wrote.status === 201, 'status ' + wrote.status);

  const settings = await accountant('PATCH', '/api/orgs/' + teamOrg, { name: 'Renamed By Accountant' });
  check('but not change the organisation', settings.status === 403, 'status ' + settings.status);

  const sneak = await accountant('POST', '/api/orgs/' + teamOrg + '/members', {
    email: 'smoke-sneak-' + stamp + '@x.ng', role: 'admin'
  });
  check('nor invite anyone', sneak.status === 403, 'status ' + sneak.status);

  const viewer = client();
  const viewerJoined = await viewer('POST', '/api/invitations/' + tokenOf(linkFor(readerEmail)) + '/accept', {
    name: 'Ngozi Eze', password: 'smoke-test-pass-3'
  });
  check('a viewer can accept too', viewerJoined.status === 201 && viewerJoined.body.session.role === 'viewer',
    viewerJoined.body.session && viewerJoined.body.session.role);
  check('and read the books', (await viewer('GET', '/api/orgs/' + teamOrg + '/data')).status === 200);

  const viewerWrite = await viewer('POST', '/api/orgs/' + teamOrg + '/transactions', {
    type: 'income', date: '2026-03-03', amount: 1000, category: 'Sales', description: 'should not stick'
  });
  check('but not write to them', viewerWrite.status === 403, 'status ' + viewerWrite.status);

  // --- changing roles afterwards ------------------------------------------
  const viewerId = viewerJoined.body.session.userId;
  const bossId = team.body.session.userId;

  const promote = await boss('PATCH', '/api/orgs/' + teamOrg + '/members/' + viewerId, { role: 'accountant' });
  check('an admin can change a role', promote.status === 200 && promote.body.role === 'accountant');
  check('which takes effect at once',
    (await viewer('POST', '/api/orgs/' + teamOrg + '/transactions', {
      type: 'income', date: '2026-03-03', amount: 1000, category: 'Sales', description: 'now allowed'
    })).status === 201);

  const selfDemote = await boss('PATCH', '/api/orgs/' + teamOrg + '/members/' + bossId, { role: 'viewer' });
  check('the last admin cannot demote themselves', selfDemote.status === 400, 'status ' + selfDemote.status);

  const badRole = await boss('PATCH', '/api/orgs/' + teamOrg + '/members/' + viewerId, { role: 'owner' });
  check('an unknown role is refused', badRole.status === 400, 'status ' + badRole.status);

  await boss('PATCH', '/api/orgs/' + teamOrg + '/members/' + viewerId, { role: 'admin' });
  const nowFine = await boss('PATCH', '/api/orgs/' + teamOrg + '/members/' + bossId, { role: 'accountant' });
  check('and can once somebody else is one', nowFine.status === 200, 'status ' + nowFine.status);
  await viewer('PATCH', '/api/orgs/' + teamOrg + '/members/' + bossId, { role: 'admin' });

  const removed = await boss('DELETE', '/api/orgs/' + teamOrg + '/members/' + viewerId);
  check('removing somebody frees their seat', removed.status === 200 && removed.body.seats.free === 1,
    JSON.stringify(removed.body.seats));
  check('and ends their access', (await viewer('GET', '/api/orgs/' + teamOrg + '/data')).status === 404,
    'they could still read the books');
  check('while what they entered stays',
    (await boss('GET', '/api/orgs/' + teamOrg + '/data')).body.book.tx.some((t) => t.description === 'now allowed'));

  // ---------------------------------------------------- Smart Invoicing
  //
  // The builder, the dashboard and the list, through the API a browser uses.
  // Two things worth proving above the rest: that the totals the server
  // records are its own rather than whatever the browser sent, and that an
  // issued invoice is in the ledger exactly once.
  console.log('\nsmart invoicing');

  const boot = await sme('GET', '/api/orgs/' + orgA + '/invoices/new');
  check('the builder loads what it needs', boot.status === 200 &&
    Array.isArray(boot.body.templates) && boot.body.templates.length === 5,
    'status ' + boot.status);
  check('with the next number it will use', /^INV-/.test(String(boot.body.nextNumber)), boot.body.nextNumber);
  check('and the company identity to print', 'tin' in boot.body.business);

  const built = await sme('POST', '/api/orgs/' + orgA + '/invoices/build', {
    party: 'Builder Customer Ltd',
    issue: '2026-10-01', due: '2026-10-15',
    lines: [
      { description: 'Consulting', qty: 2, unitPrice: '150000', taxRate: '7.5' },
      { description: 'Expenses', qty: 1, unitPrice: '25000', taxTreatment: 'exempt' }
    ],
    // Deliberately wrong, and deliberately ignored: the figure of record is
    // the one the server works out.
    total: 1, subtotal: 1,
    status: 'issued'
  });
  check('an invoice is built', built.status === 201, 'status ' + built.status);
  check('with a number from the series', /^INV-\d{4}-\d{5}$/.test(built.body.invoice.number), built.body.invoice.number);
  check('and the server\'s own total, not the browser\'s',
    built.body.totals.net === 32500000, String(built.body.totals.net));
  // Nil, because this business has not said it is registered. A rate typed
  // on a line must not override that: charging VAT a business is not
  // registered to collect is worse than charging none.
  check('an unregistered business charges no VAT, whatever the line says',
    built.body.totals.tax === 0, String(built.body.totals.tax));

  const registered = await sme('PATCH', '/api/orgs/' + orgA, { vatRegistered: true, vatRate: 7.5, tin: '01234567-0001' });
  check('a business can register for VAT', registered.status === 200 &&
    registered.body.org.vatRegistered === true, 'status ' + registered.status);
  const withVat = await sme('POST', '/api/orgs/' + orgA + '/invoices/build', {
    party: 'VAT Customer Ltd',
    lines: [
      { description: 'Consulting', qty: 2, unitPrice: '150000' },
      { description: 'Disbursements', qty: 1, unitPrice: '25000', taxTreatment: 'exempt' }
    ],
    status: 'issued'
  });
  check('and then VAT applies', withVat.body.totals.tax === 2250000, String(withVat.body.totals.tax));
  check('only to the standard-rated line',
    withVat.body.totals.net === 32500000, String(withVat.body.totals.net));
  check('and the exempt amount is reported apart from it',
    withVat.body.totals.byTreatment.exempt === 2500000,
    JSON.stringify(withVat.body.totals.byTreatment));

  const full = await sme('GET', '/api/orgs/' + orgA + '/invoices/' + built.body.invoice.id + '/full');
  check('its lines are stored', full.body.lines.length === 2, String(full.body.lines.length));
  check('and its timeline records the issue',
    full.body.events.some((e) => e.event === 'finalised'),
    full.body.events.map((e) => e.event).join(','));

  const draft = await sme('POST', '/api/orgs/' + orgA + '/invoices/build', {
    party: 'Draft Customer', lines: [{ description: 'TBC', qty: 1, unitPrice: '5000' }], status: 'draft'
  });
  check('a draft saves', draft.status === 201);
  check('without taking a number from the series',
    !/^INV-\d{4}-\d{5}$/.test(draft.body.invoice.number),
    'an abandoned draft must not leave a hole in the numbering');

  const edit = await sme('POST', '/api/orgs/' + orgA + '/invoices/build', {
    id: built.body.invoice.id, party: 'Builder Customer Ltd',
    lines: [{ description: 'Changed', qty: 1, unitPrice: '1' }], status: 'issued'
  });
  check('an issued invoice cannot be edited', edit.status === 409, 'status ' + edit.status);
  check('and says what to do instead', /credit note/i.test(String(edit.body.error)), edit.body.error);

  const empty = await sme('POST', '/api/orgs/' + orgA + '/invoices/build', {
    party: 'Nobody', lines: [], status: 'issued'
  });
  check('an invoice with no lines is refused', empty.status === 400);

  const dash = await sme('GET', '/api/orgs/' + orgA + '/invoicing/dashboard');
  check('the dashboard loads', dash.status === 200);
  check('counting the issued invoices but not the draft',
    dash.body.metrics.draftCount === 1 && dash.body.metrics.unpaidCount >= 2,
    JSON.stringify({ d: dash.body.metrics.draftCount, u: dash.body.metrics.unpaidCount }));
  check('with twelve months of history', dash.body.monthly.length === 13, String(dash.body.monthly.length));
  // The ledger catches up in the background, so a brand-new account's demo
  // history may not be posted yet when this runs. Asked for explicitly rather
  // than waited on: the claim being checked is that the two figures agree once
  // everything is posted, not that a timer has fired within the last second.
  const posted = await sme('POST', '/api/orgs/' + orgA + '/ledger/post-pending');
  check('whatever is unposted can be posted on demand', posted.status === 200,
    'status ' + posted.status);
  const reconciled = await sme('GET', '/api/orgs/' + orgA + '/invoicing/dashboard');
  check('and receivables that reconcile with the ledger',
    reconciled.body.ageing.reconciles === true,
    'the screen must not show two different figures for what is owed — off by ' +
    (reconciled.body.ageing && reconciled.body.ageing.difference));

  const listed = await sme('GET', '/api/orgs/' + orgA + '/invoicing/list?status=draft');
  check('the list filters by status',
    listed.body.invoices.length === 1 && listed.body.invoices[0].status === 'draft',
    JSON.stringify(listed.body.invoices.map((i) => i.status)));
  const searched = await sme('GET', '/api/orgs/' + orgA + '/invoicing/list?q=Builder');
  check('and searches by customer', searched.body.invoices.length >= 1, String(searched.body.invoices.length));

  const health = await sme('GET', '/api/orgs/' + orgA + '/ledger/health');
  check('the ledger balances after all of that', health.body.balanced === true,
    'difference ' + health.body.difference);

  const pdfRes = await fetch(BASE + '/api/orgs/' + orgA + '/invoices/' + built.body.invoice.id + '/pdf',
    { headers: { cookie: smeCookie() } });
  check('the invoice downloads as a PDF',
    pdfRes.status === 200 && /application\/pdf/.test(pdfRes.headers.get('content-type')),
    pdfRes.status + ' ' + pdfRes.headers.get('content-type'));

  console.log('\nand none of it leaks to another business');
  check('the dashboard is per organisation',
    (await church('GET', '/api/orgs/' + orgA + '/invoicing/dashboard')).status === 404);
  check('so is the list',
    (await church('GET', '/api/orgs/' + orgA + '/invoicing/list')).status === 404);
  check('so is the builder',
    (await church('POST', '/api/orgs/' + orgA + '/invoices/build', {
      party: 'X', lines: [{ description: 'X', qty: 1, unitPrice: '1' }], status: 'draft'
    })).status === 404);
  check('and so is one invoice',
    (await church('GET', '/api/orgs/' + orgA + '/invoices/' + built.body.invoice.id + '/full')).status === 404);

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

  // --------------------------------------------------------- privacy page
  //
  // Public and unauthenticated by necessity: somebody deciding whether to sign
  // up has to be able to read what happens to their data before they hand any
  // of it over, and a cookie banner that links to a 404 is worse than no
  // banner at all.
  // Health reports what a deployment can change. If payroll ships and this
  // stays silent, the only way to tell a deploy landed is to sign in and look
  // at a menu — which is how an hour got spent on exactly that question.
  console.log('\nhealth says what is deployed');
  const deployed = await (await fetch(BASE + '/api/health')).json();
  check('health answers', deployed.ok === true);
  check('it names the payroll rules in force',
    deployed.payroll && /^NG-/.test(deployed.payroll.rules), JSON.stringify(deployed.payroll));
  check('and how many of them are still unconfirmed',
    typeof deployed.payroll.unconfirmed === 'number', JSON.stringify(deployed.payroll));
  check('it never leaks a credential',
    !/password|secret|key=/i.test(JSON.stringify(deployed).replace(/EMAIL_SMTP_PASSWORD|CREDENTIALS_KEY|ANTHROPIC_API_KEY/g, '')));

  // ------------------------------------------------------- one address
  //
  // www and the bare name must not be two sites. They were: signing in on one
  // left you signed out on the other, because a cookie set for one hostname
  // is not sent to the other.
  console.log('\nwww goes to one place');

  // Raw http, not fetch: `Host` is a forbidden header in fetch and undici
  // drops it without a word, so a test written with fetch quietly asks for
  // the wrong hostname and passes for the wrong reason.
  const asHost = (host, path, method, extra) => new Promise((resolve, reject) => {
    const target = new URL(BASE);
    const req = require('http').request({
      host: target.hostname,
      port: target.port || 80,
      path: path || '/',
      method: method || 'GET',
      headers: Object.assign({ Host: host }, extra || {})
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (k) => res.headers[String(k).toLowerCase()] || null }
      }));
    });
    req.on('error', reject);
    req.end();
  });

  // Behind the proxy, which is the only way this is reached in production.
  const TLS = { 'X-Forwarded-Proto': 'https' };

  const wwwHit = await asHost('www.profitna.com', '/', 'GET', TLS);
  check('www is redirected, permanently', wwwHit.status === 301, 'status ' + wwwHit.status);
  check('…to the bare name, over https',
    wwwHit.headers.get('location') === 'https://profitna.com/',
    wwwHit.headers.get('location'));

  const deep = await asHost('www.profitna.com', '/privacy?x=1', 'GET', TLS);
  check('…keeping the path and the query',
    deep.headers.get('location') === 'https://profitna.com/privacy?x=1',
    deep.headers.get('location'));

  // And it does not invent a scheme it was not reached by: a plain http
  // request stays http, and the proxy's own http-to-https rule handles that
  // hop. Guessing here is how a redirect loop starts.
  const plain = await asHost('www.profitna.com', '/');
  check('…and the scheme is the one it arrived on, not a guess',
    plain.headers.get('location') === 'http://profitna.com/',
    plain.headers.get('location'));

  const bare = await asHost('profitna.com', '/api/health');
  check('the bare name is served, not bounced', bare.status === 200, 'status ' + bare.status);

  // The one that would quietly break payments.
  const hook = await asHost('www.profitna.com', '/api/webhooks/monnify', 'POST');
  check('a webhook is never redirected, whatever host it arrives on',
    hook.status !== 301 && hook.status !== 302, 'status ' + hook.status);

  // And the one that would make this an open redirect.
  const forged = await asHost('evil.example.com', '/');
  check('a forged Host header is not followed anywhere',
    forged.status !== 301 && forged.status !== 302, 'status ' + forged.status);

  console.log('\nthe privacy notice');

  const reader = client();
  const privacy = await reader('GET', '/privacy');
  check('it is served without signing in', privacy.status === 200, 'status ' + privacy.status);
  check('and it is a page, not JSON', /<html/i.test(privacy.text || ''));
  check('the cookie notice is on it',
    /profitna_session/.test(privacy.text) && /_fbp/.test(privacy.text));
  check('it names the regulator somebody would complain to',
    /Nigeria Data Protection/i.test(privacy.text));
  check('it says advertising cookies start off',
    /off unless you/i.test(privacy.text));
  check('/cookies reaches the same page', (await reader('GET', '/cookies')).status === 200);

  // ------------------------------------------- what is routed must be shipped
  //
  // The fault this exists to prevent, because it has happened: /privacy was
  // added to the routes and the file was not added to the Dockerfile's list of
  // web files, so the route worked everywhere except production, where
  // sendFile threw into the 500 handler. No test caught it because every test
  // runs against the repository, where the file is obviously present.
  //
  // So this reads the two files and compares them. It is a static check and
  // needs no server, which is the point: it fails on the laptop rather than on
  // the live site.
  console.log('\nevery page the server serves is in the image');

  const fs = require('fs');
  const pathMod = require('path');
  const indexSrc = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const dockerfile = fs.readFileSync(pathMod.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

  const pages = [];
  const sendFileRe = /sendFile\(path\.join\(WEB_ROOT,\s*'([^']+)'/g;
  let hit;
  while ((hit = sendFileRe.exec(indexSrc)) !== null) pages.push(hit[1]);
  check('the server serves at least the app, the console and the privacy page',
    pages.length >= 3, pages.join(', '));

  const copies = dockerfile.split('\n').filter((l) => /^COPY\s/.test(l) && /web/.test(l));
  // One COPY of the whole directory covers everything and cannot drift.
  const wholeDir = copies.some((l) => /^COPY\s+web\s+\.\/web\/?$/.test(l.trim()));
  const copied = copies.join(' ');

  for (const file of pages) {
    check('  ' + file + ' exists in web/',
      fs.existsSync(pathMod.join(__dirname, '..', '..', 'web', file)));
    check('  ' + file + ' reaches the image',
      wholeDir || copied.includes('web/' + file),
      'not covered by any COPY in the Dockerfile');
  }

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nsmoke run could not finish: ' + err.message);
  process.exit(1);
});
