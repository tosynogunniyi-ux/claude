// Can every screen still be drawn?
//   npm run test:screens
//
// The whole interface is one function. Everything it builds, it builds on
// every render — so a section that throws because one figure came back in an
// unexpected shape does not break its own screen, it breaks the entire app,
// and a reload reproduces it because the fault lives in the data. That is
// being locked out of your own books by a bad row.
//
// There is a guard for this (`section()` in the page), and a guard nobody has
// ever seen fire is a guard nobody knows works. So this does not read the
// code and agree with it. It breaks every API the screens depend on, one at a
// time, and checks three things each time:
//
//   the app still draws — the shell, the navigation, the other screens;
//   the damage is confined to the screen that reads the broken endpoint;
//   nothing throws into the console, which is where a React render failure
//   goes before it takes the page with it.
//
// It drives a real browser against a real server and a real database, because
// the failure being tested is a rendering failure and nothing short of a
// renderer can have it.

require('dotenv').config();
const path = require('path');
const { chromium } = require(path.join(__dirname, 'browser'));

const BASE = process.env.SCREENS_BASE || 'http://localhost:4000';

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// Every screen in the navigation, and every tab inside Invoicing.
const SCREENS = [
  'Dashboard', 'Ask Profitna', 'Invoicing', 'Invoices', 'Customers & Suppliers',
  'Bills', 'Expenses & Income', 'Products', 'Reconciliation', 'Reports', 'Settings'
];
const TABS = ['Invoices', 'Payments', 'Credit notes', 'Recurring', 'Receivables'];

// The calls each screen depends on. Breaking one must cost that screen and
// nothing else.
const ENDPOINTS = [
  { label: 'the whole book', match: '**/api/orgs/*/data', screen: 'Dashboard' },
  { label: 'the invoicing dashboard', match: '**/api/orgs/*/invoicing/dashboard', screen: 'Invoicing' },
  { label: 'the invoice list', match: '**/api/orgs/*/invoicing/list*', screen: 'Invoicing', tab: 'Invoices' },
  { label: 'the receipts list', match: '**/api/orgs/*/payments?*', screen: 'Invoicing', tab: 'Payments' },
  { label: 'credit notes', match: '**/api/orgs/*/credit-notes?*', screen: 'Invoicing', tab: 'Credit notes' },
  { label: 'the schedules', match: '**/api/orgs/*/recurring', screen: 'Invoicing', tab: 'Recurring' },
  { label: 'receivables', match: '**/api/orgs/*/receivables', screen: 'Invoicing', tab: 'Receivables' },
  { label: 'the payment accounts', match: '**/api/orgs/*/payment-accounts', screen: 'Settings' },
  { label: 'the ledger health', match: '**/api/orgs/*/ledger/health', screen: 'Reports' }
];

// What a broken endpoint can send back. Each is something a real deployment
// has produced at least once: a half-rolled-out server answering an older
// shape, a proxy returning its own page, a row that is null where the screen
// expected an object.
const CORRUPTIONS = [
  { name: 'an empty object', body: '{}', type: 'application/json' },
  { name: 'null', body: 'null', type: 'application/json' },
  { name: 'an array where an object belongs', body: '[]', type: 'application/json' },
  { name: 'nulls inside every field', body: null, type: 'application/json', nullify: true },
  { name: "a proxy's HTML error page", body: '<html><body>502 Bad Gateway</body></html>', type: 'text/html' }
];

// Replaces every value in a payload with null, keeping the keys — the shape a
// server returns when a join comes back empty and nothing guards it.
function nullify(json) {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return 'null';
    const out = Array.isArray(parsed) ? [] : {};
    for (const k of Object.keys(parsed)) out[k] = null;
    return JSON.stringify(out);
  } catch { return 'null'; }
}

async function go(page, label, wait) {
  const ok = await page.evaluate((t) => {
    const all = [...document.querySelectorAll('button')].filter((b) => !b.disabled);
    // A navigation button carries its count — "Bills 5" — so an exact match
    // misses exactly the screens that have something on them.
    const el = all.find((b) => b.textContent.trim() === t)
      || all.find((b) => b.textContent.trim().replace(/\s*\d+$/, '') === t);
    if (el) { el.click(); return true; }
    return false;
  }, label);
  await page.waitForTimeout(wait || 900);
  return ok;
}

// The three facts worth knowing after every navigation.
function inspect(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      // The sidebar is the app. If it is gone, the whole page went with it.
      shell: /Dashboard/.test(text) && /Settings/.test(text),
      crashed: /could not be drawn/.test(text),
      crashOf: (text.match(/(.+?) could not be drawn/) || [])[1] || null,
      // A blank page renders as almost nothing; a drawn one does not.
      length: text.length
    };
  });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  // Two different things, and conflating them would make this test useless.
  //
  // `thrown` is a failure nothing caught — React unmounting the tree, a
  // handler exploding. That is the fault this suite exists to prevent.
  //
  // `contained` is the guard doing its job: a section threw, section() caught
  // it, and the app put a panel on that screen and carried on. Under fault
  // injection that is the correct outcome, not a failure — so it is counted
  // and reported, never failed on.
  const thrown = [];
  const contained = [];
  page.on('pageerror', (e) => thrown.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/\[profitna\]/.test(t)) { contained.push(t.split('\n')[0]); return; }
    // The renderer logs its own template noise about SVG attributes, which is
    // harmless and predates all of this.
    if (/Minified React error|Cannot read|is not a function|undefined is not/.test(t)) {
      thrown.push('console: ' + t.split('\n')[0]);
    }
  });
  const sinceLast = () => { const out = thrown.slice(); thrown.length = 0; return out; };
  const containedSince = () => { const out = contained.slice(); contained.length = 0; return out; };

  const finish = async (code) => { await browser.close(); process.exit(code); };

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const stamp = Date.now();
    const signup = await page.evaluate(async (e) => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ name: 'Screen Test', org: 'Screens ' + Date.now(), email: e,
          password: 'screens-test-pass-1', book: 'sme', cycle: 'monthly', users: 1 })
      });
      return { status: res.status, body: await res.json() };
    }, 'screens-' + stamp + '@mideops.ng');
    if (signup.status !== 201) throw new Error('signup failed: ' + JSON.stringify(signup.body));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // ------------------------------------------------------------------
    console.log('\nevery screen draws, on an ordinary account');
    for (const screen of SCREENS) {
      const found = await go(page, screen, 1400);
      const state = await inspect(page);
      const errs = sinceLast();
      containedSince();
      check(screen.toLowerCase() + ' draws',
        found && state.shell && !state.crashed && errs.length === 0,
        !found ? 'no nav button' : state.crashed ? 'crash panel' : errs.join(' | ') || 'shell missing');
    }

    console.log('\nand every tab inside Invoicing');
    await go(page, 'Invoicing', 1500);
    for (const tab of TABS) {
      const found = await go(page, tab, 1300);
      const state = await inspect(page);
      const errs = sinceLast();
      containedSince();
      check('the ' + tab.toLowerCase() + ' tab draws',
        found && state.shell && !state.crashed && errs.length === 0,
        !found ? 'no tab button' : state.crashed ? 'crash panel' : errs.join(' | '));
    }

    console.log('\nand every form opens');
    const FORMS = [
      ['Invoicing', 'Invoices', '+ Create invoice', 'Close'],
      ['Invoicing', 'Payments', '+ Record a payment', 'Close'],
      ['Invoicing', 'Recurring', '+ New schedule', 'Close']
    ];
    for (const [screen, tab, open, close] of FORMS) {
      await go(page, screen, 1200);
      await go(page, tab, 1100);
      const opened = await go(page, open, 1800);
      const state = await inspect(page);
      const errs = sinceLast();
      check(open.replace('+ ', '').toLowerCase() + ' opens',
        opened && !state.crashed && errs.length === 0,
        !opened ? 'button not found' : state.crashed ? 'crash panel' : errs.join(' | '));
      await go(page, close, 900);
      sinceLast();
    }

    // ------------------------------------------------------------------
    // The part that matters: break each call and prove the damage stops at
    // the screen that reads it.
    console.log('\nwhen an endpoint answers with something unexpected');

    for (const ep of ENDPOINTS) {
      for (const bad of CORRUPTIONS) {
        await page.unrouteAll().catch(() => {});
        await page.route(ep.match, async (route) => {
          let body = bad.body;
          if (bad.nullify) {
            const real = await route.fetch().catch(() => null);
            body = nullify(real ? await real.text() : '{}');
          }
          return route.fulfill({ status: 200, contentType: bad.type, body });
        });

        // Reload so the broken call is the one the screen reads.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1600);
        sinceLast();

        await go(page, ep.screen, 1500);
        if (ep.tab) await go(page, ep.tab, 1300);
        const state = await inspect(page);
        const errs = sinceLast();
        const held = containedSince();

        // The app still stands. Whether the screen itself drew or showed its
        // "could not be drawn" panel is not the question — both are survivable
        // and both leave a way out. Nothing uncaught is the question.
        check(ep.label + ' returning ' + bad.name + ' does not take the app down',
          state.shell && errs.length === 0,
          !state.shell ? 'the shell is gone' : errs.join(' | '));
        if (held.length) console.log('       (contained: ' + held[0].slice(0, 90) + ')');

        // Whatever happened to that screen, the dashboard must still be
        // reachable and readable. This is the whole point of containment.
        await go(page, 'Dashboard', 1400);
        const after = await inspect(page);
        const afterErrs = sinceLast();
        containedSince();
        check('  …and the dashboard still works after it',
          after.shell && !after.crashed && after.length > 200 && afterErrs.length === 0,
          after.crashed ? 'the dashboard shows a crash panel' : afterErrs.join(' | ') || 'length ' + after.length);
      }
    }

    await page.unrouteAll().catch(() => {});

    // ------------------------------------------------------------------
    console.log('\nand when the server stops answering at all');
    await page.route('**/api/orgs/**', (route) => route.abort('failed'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    sinceLast();
    for (const screen of ['Invoicing', 'Reports', 'Settings', 'Dashboard']) {
      await go(page, screen, 1200);
      const state = await inspect(page);
      const errs = sinceLast();
      containedSince();
      check(screen.toLowerCase() + ' survives a dead API',
        state.shell && errs.length === 0,
        !state.shell ? 'the shell is gone' : errs.join(' | '));
    }
    await page.unrouteAll().catch(() => {});

    // ------------------------------------------------------------------
    console.log('\nthe guard itself');
    // Containment is only worth something if it has been watched working.
    // Everything above now degrades so gracefully that the net rarely gets
    // touched — which is the right outcome and a poor proof. So this sends a
    // payload shaped to pass every guard and still throw deeper in, and
    // checks the three things that must then be true: the screen says so,
    // the rest of the app stands, and nothing escaped uncaught.
    await page.unrouteAll().catch(() => {});
    await page.route('**/api/orgs/*/receivables', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      // Everything receivablesVals checks for is present and the thing it
      // reaches for afterwards is not.
      body: JSON.stringify({ ageing: { buckets: {} }, byCustomer: [], overdue: [],
        invoices: [], unallocatedPayments: [], openCredits: [] })
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    sinceLast(); containedSince();

    await go(page, 'Invoicing', 1500);
    await go(page, 'Receivables', 1500);
    const broken = await inspect(page);
    const escaped = sinceLast();
    const caught = containedSince();

    check('a section that throws is caught rather than escaping',
      caught.length > 0 && escaped.length === 0,
      escaped.length ? 'escaped: ' + escaped.join(' | ') : 'the guard never fired');
    check('the screen says it could not be drawn, and says which screen',
      broken.crashed && broken.crashOf === 'Invoicing',
      broken.crashed ? 'named "' + broken.crashOf + '"' : 'no panel shown');
    check('the shell is still there, so there is a way out',
      broken.shell, 'the navigation went with it');

    await go(page, 'Dashboard', 1500);
    const recovered = await inspect(page);
    check('and leaving the broken screen leaves the fault behind',
      recovered.shell && !recovered.crashed && sinceLast().length === 0,
      recovered.crashed ? 'the dashboard inherited the panel' : 'shell missing');
    await page.unrouteAll().catch(() => {});

    // ------------------------------------------------------------------
    console.log('\nand the server itself');
    // Node ends the process on an unhandled rejection by default. For the one
    // process serving a live accounting product that turns a hiccup in a
    // background timer into an outage for every business using it. The
    // handler keeps it serving and counts the fault; /api/health is where the
    // count is visible, because a process quietly limping is worse than one
    // that fell over honestly.
    const health = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return { status: res.status, body: await res.json() };
    });
    check('the server answers, and says whether anything has thrown',
      health.status === 200 && health.body.ok === true && 'faults' in health.body,
      JSON.stringify(health.body && health.body.faults));
    check('and nothing has',
      health.body.faults === 'none', JSON.stringify(health.body.faults));

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
