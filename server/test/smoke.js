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
    users: 1
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

  console.log('\nthe card-free trial');
  const trial = a.body.session;
  check('signup asks for no card', trial.card === null, JSON.stringify(trial.card));
  check('and starts a trial', trial.subStatus === 'trialing' && trial.access === 'trial', trial.access);
  check('with 14 days on it', trial.daysLeft === 14, String(trial.daysLeft));
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
