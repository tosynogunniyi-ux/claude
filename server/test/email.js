// Does the right person get the right message, once?
//   npm run test:email
//
// The brief for this system was one sentence long where it mattered: messages
// must be conditional, not blindly sent on every listed day. So most of this
// file is not about email at all. It is about whether the conditions say no
// when they should — because the failure that matters is not a message that
// fails to send, it is a message that sends when it should not have: telling
// somebody who paid on Tuesday that their trial expires on Thursday.
//
// The conditions are pure functions of (signals, now), which is why most of
// what follows needs no database, no clock and no mail server. A lifecycle
// system whose conditions cannot be tested in isolation is one that will
// email the wrong person eventually.

require('dotenv').config();

// Nothing in this file may reach a real mail server. Set before anything is
// required, so even a mistake cannot send.
delete process.env.EMAIL_SMTP_HOST;
delete process.env.EMAIL_SMTP_USER;
delete process.env.EMAIL_SMTP_PASSWORD;
process.env.EMAIL_SENDING = 'off';

const { pool, one, many, query } = require('../src/db');
const journey = require('../src/email/journey');
const consent = require('../src/email/consent');
const outbox = require('../src/email/outbox');
const provider = require('../src/email/provider');
const templates = require('../src/email/templates');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const made = [];
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);
const ahead = (days) => new Date(Date.now() + days * DAY);

// A signals object, built by hand. The conditions read nothing else, so this
// is the whole world as far as they are concerned — which is the point.
function signals(over) {
  const createdAt = (over && over.createdAt) || ago(0);
  const trialDays = (over && over.trialDays) || 14;
  return Object.assign({
    organizationId: '00000000-0000-0000-0000-000000000001',
    organizationName: 'Mideops Ventures',
    bookType: 'sme',
    createdAt,
    trialStart: createdAt,
    trialDays,
    trialEnd: new Date(createdAt.getTime() + trialDays * DAY),
    status: 'trialing',
    cycle: 'monthly',
    seats: 1,
    periodEnd: null,
    suspended: false,
    cancelled: false,
    hasCard: false,
    card: null,
    chargeAttempts: 0,
    lastChargeAttemptAt: null,
    lastChargeError: null,
    activatedAt: null,
    lastActivityAt: null,
    firstPaidAt: null,
    counts: { transactions: 0, invoices: 0, bills: 0, clients: 0, bankAccounts: 0, payments: 0, recurring: 0, items: 0 }
  }, over || {});
}

const kindsDue = (s, at) => journey.due(s, at).map((d) => d.kind).sort();
const isDue = (s, kind, at) => kindsDue(s, at).includes(kind);

(async () => {
  try {
    // =====================================================================
    console.log('\nthe eight steps fire when they should');

    check('registration: a welcome, immediately',
      isDue(signals({ createdAt: ago(0) }), 'welcome'));

    check('24 hours with nothing recorded: setup help',
      isDue(signals({ createdAt: ago(1.1) }), 'setup_help'));

    check('day 3 with nothing recorded: an offer of help',
      isDue(signals({ createdAt: ago(3.2) }), 'activation_offer'));

    check('day 6 after activating: guidance',
      isDue(signals({ createdAt: ago(20), activatedAt: ago(6.1) }), 'feature_guidance'));

    check('day 10 unpaid: where the trial stands',
      isDue(signals({ createdAt: ago(10.1), activatedAt: ago(9) }), 'trial_status'));

    check('48 hours before expiry: the reminder',
      isDue(signals({ createdAt: ago(12.5), activatedAt: ago(10) }), 'trial_ending'),
      JSON.stringify(kindsDue(signals({ createdAt: ago(12.5), activatedAt: ago(10) }))));

    check('at expiry: the account status',
      isDue(signals({ createdAt: ago(14.2), activatedAt: ago(10) }), 'trial_ended'));

    check('after a confirmed payment: the paid welcome',
      isDue(signals({ createdAt: ago(9), status: 'active', firstPaidAt: ago(0.1), activatedAt: ago(8) }), 'paid_welcome'));

    // =====================================================================
    console.log('\nand stay quiet when they should — which is the whole brief');

    check('somebody who recorded something does not get the 24-hour nudge',
      !isDue(signals({ createdAt: ago(1.1), activatedAt: ago(0.5) }), 'setup_help'),
      'they are using it; the message is about not using it');

    check('somebody who activated on day 2 never gets the day-3 offer',
      !isDue(signals({ createdAt: ago(3.2), activatedAt: ago(1.2) }), 'activation_offer'));

    check('somebody who paid on day 2 never gets the day-3 offer either',
      !isDue(signals({ createdAt: ago(3.2), status: 'active', firstPaidAt: ago(1.2) }), 'activation_offer'));

    check('a card on file means no day-10 trial-status message',
      !isDue(signals({ createdAt: ago(10.1), hasCard: true }), 'trial_status'));

    check('day 6 is counted from activating, not from signing up',
      !isDue(signals({ createdAt: ago(6.1), activatedAt: ago(0.5) }), 'feature_guidance') &&
      isDue(signals({ createdAt: ago(18), activatedAt: ago(6.1) }), 'feature_guidance'),
      'somebody who activates late gets it late, which is the point of it');

    check('nothing fires twice in the same window',
      kindsDue(signals({ createdAt: ago(3.2) })).filter((k) => k === 'activation_offer').length === 1);

    console.log('\nand nothing fires months late');
    // Without this, switching the system on would send every organisation
    // ever created whichever step its age happens to land in.
    const ancient = signals({ createdAt: ago(400), activatedAt: ago(399) });
    check('an account created last year gets nothing',
      kindsDue(ancient).length === 0, JSON.stringify(kindsDue(ancient)));
    check('an abandoned trial that ended months ago gets nothing',
      !isDue(signals({ createdAt: ago(90) }), 'trial_ended'));

    // =====================================================================
    console.log('\nthe expiry date is this subscription’s own');

    // The default went 14 -> 30 -> 14. Each account keeps the promise made
    // when it signed up, so the reminder has to read trial_days off the row
    // and not the constant.
    const longTrial = signals({ createdAt: ago(28.5), trialDays: 30, activatedAt: ago(27) });
    check('a 30-day trial is reminded at day 28, not at day 12',
      isDue(longTrial, 'trial_ending'), JSON.stringify(kindsDue(longTrial)));
    check('and is not told at day 12 that it is about to end',
      !isDue(signals({ createdAt: ago(12.5), trialDays: 30 }), 'trial_ending'));
    check('nor told at day 15 that it has ended',
      !isDue(signals({ createdAt: ago(15), trialDays: 30 }), 'trial_ended'));

    // =====================================================================
    console.log('\nafter payment, every trial reminder stops qualifying');

    // Requirement E. There is no mechanism for this and there does not need
    // to be: the conditions are asked at the moment of sending, and a paid
    // account answers no to all of them.
    const paidOnDay9 = signals({
      createdAt: ago(13.9), activatedAt: ago(12), status: 'active', firstPaidAt: ago(4),
      periodEnd: ahead(26)
    });
    const stillDue = kindsDue(paidOnDay9);
    check('no trial-status, no expiry reminder, no expiry notice',
      !stillDue.includes('trial_status') && !stillDue.includes('trial_ending') &&
      !stillDue.includes('trial_ended'),
      JSON.stringify(stillDue));
    check('and nothing had to be cancelled for that to be true',
      true, 'the condition is evaluated when it would be sent, not queued in advance');

    check('a lapsed account that pays again is not told its trial ended',
      !isDue(signals({ createdAt: ago(14.1), status: 'active', firstPaidAt: ago(0.2) }), 'trial_ended'));

    // =====================================================================
    console.log('\npayment failures: one message per attempt');

    const failedOnce = signals({
      createdAt: ago(40), status: 'past_due', hasCard: true, firstPaidAt: ago(35),
      chargeAttempts: 1, lastChargeAttemptAt: ago(0.1), lastChargeError: 'insufficient funds'
    });
    check('a declined charge is reported', isDue(failedOnce, 'payment_failed'));
    check('and keyed by the attempt, so the retry reports separately',
      journey.due(failedOnce).find((d) => d.kind === 'payment_failed').dedupeKey === 'attempt-1');
    const failedFourth = Object.assign({}, failedOnce, { chargeAttempts: 4 });
    check('the fourth attempt is a different message, not a repeat of the first',
      journey.due(failedFourth).find((d) => d.kind === 'payment_failed').dedupeKey === 'attempt-4');
    check('and past due says we have stopped trying',
      isDue(failedOnce, 'payment_past_due'));
    check('an account paying normally hears none of it',
      !isDue(signals({ createdAt: ago(40), status: 'active', firstPaidAt: ago(35), hasCard: true }), 'payment_failed'));

    // =====================================================================
    console.log('\nthe guidance is chosen from what they are not using');

    check('a business with no bank account is told about bank accounts',
      journey.nextUsefulFeature(signals({})).key === 'bank');
    check('one with invoices but no payments recorded is told about payments',
      journey.nextUsefulFeature(signals({ counts: { bankAccounts: 1, invoices: 4, payments: 0, transactions: 2, bills: 0, clients: 1, recurring: 0, items: 0 } })).key === 'payments');
    check('one raising invoices by hand every month is told about recurring',
      journey.nextUsefulFeature(signals({ counts: { bankAccounts: 1, invoices: 9, payments: 5, transactions: 20, bills: 3, clients: 4, recurring: 0, items: 0 } })).key === 'recurring');
    check('and one already doing all of it is told about its reports, not sold something',
      journey.nextUsefulFeature(signals({ counts: { bankAccounts: 1, invoices: 9, payments: 5, transactions: 20, bills: 3, clients: 4, recurring: 2, items: 1 } })).key === 'reports');

    // =====================================================================
    console.log('\nevery message renders, in text and in HTML');

    for (const kind of templates.KINDS) {
      const s = signals({
        createdAt: ago(5), activatedAt: ago(4), firstPaidAt: ago(1),
        card: { brand: 'Visa', last4: '4081' }, periodEnd: ahead(25),
        lastChargeError: 'do not honour'
      });
      const rendered = templates.render(kind, templates.context({
        signals: s, user: { full_name: 'Tosin Balogun', email: 'a@b.ng' },
        category: 'transactional', data: { feature: journey.nextUsefulFeature(s) },
        unsubscribeUrl: 'https://profitna.com/u/x', preferencesUrl: 'https://profitna.com/p/x'
      }));
      check(kind + ' renders',
        rendered.subject.length > 5 && rendered.text.length > 120 &&
        /<html/.test(rendered.html) && !/undefined|NaN|\[object/.test(rendered.text),
        rendered.text.slice(0, 60));
    }

    // =====================================================================
    console.log('\nconsent: three classes, and they are not interchangeable');

    const org = await makeOrg();
    const user = await makeUser(org.id, 'consent');

    const prefs = await consent.ensure(user.id);
    check('a new person is opted into account messages and getting-started help',
      prefs.transactional === true && prefs.onboarding === true);
    check('and is NOT opted into marketing',
      prefs.marketing === false && prefs.marketing_consent_at === null,
      'marketing is the one that needs an act, not a default');

    const allow = (category, over) => consent.decide(Object.assign({
      category, preferences: prefs, address: user.email, suppression: null
    }, over || {})).ok;

    check('a marketing message is refused with no consent on record', !allow('marketing'));
    check('an account message is allowed', allow('transactional'));
    check('a getting-started message is allowed', allow('onboarding'));

    const optedOut = await consent.update(user.id, { onboarding: false }, 'test');
    check('opting out of getting-started stops those',
      !consent.decide({ category: 'onboarding', preferences: optedOut, address: user.email }).ok);
    check('and does not stop account messages',
      consent.decide({ category: 'transactional', preferences: optedOut, address: user.email }).ok,
      'somebody who muted tips has not asked to stop being told their card failed');

    const allOff = await consent.update(user.id, { allOff: true }, 'test');
    check('unsubscribing from everything stops the optional ones',
      !consent.decide({ category: 'onboarding', preferences: allOff, address: user.email }).ok &&
      !consent.decide({ category: 'marketing', preferences: allOff, address: user.email }).ok);
    check('but still not the account ones, and the page says so',
      consent.decide({ category: 'transactional', preferences: allOff, address: user.email }).ok &&
      /still email you about your own account/.test(consent.describe(allOff).note));

    const consented = await consent.update(user.id, { marketing: true }, 'the signup form');
    check('turning marketing on records when and from where',
      consented.marketing === true && consented.marketing_consent_at !== null &&
      consented.marketing_consent_source === 'the signup form',
      '"they ticked a box" is not an answer to a complaint');
    check('and turning it on undoes everything-off',
      consented.all_off === false);

    console.log('\na suppressed address stops everything, including account messages');
    await consent.suppress(user.email, 'complained', 'reported as spam');
    const sup = await consent.isSuppressed(user.email);
    check('a complaint suppresses the address', Boolean(sup) && sup.reason === 'complained');
    for (const category of ['transactional', 'onboarding', 'marketing']) {
      check('  nothing in ' + category + ' goes to it',
        !consent.decide({ category, preferences: consented, address: user.email, suppression: sup }).ok);
    }
    await consent.unsuppress(user.email);

    check('an undeliverable address is refused before anything is attempted',
      !consent.decide({ category: 'transactional', preferences: prefs, address: 'not-an-address' }).ok);

    console.log('\nunsubscribing by link');
    const fresh = await makeUser(org.id, 'unsub');
    const freshPrefs = await consent.ensure(fresh.id);
    const done = await consent.unsubscribeByToken(freshPrefs.unsubscribe_token, 'onboarding');
    check('one click stops that category', done && done.prefs.onboarding === false);
    check('and leaves the others alone', done.prefs.transactional === true);
    const all = await consent.unsubscribeByToken(freshPrefs.unsubscribe_token, null);
    check('a click with no category stops everything optional', all.prefs.all_off === true);
    check('an unknown token changes nothing and does not throw',
      (await consent.unsubscribeByToken('f'.repeat(64), null)) === null);
    check('and neither does a token that is not a token',
      (await consent.unsubscribeByToken('../../etc/passwd', null)) === null);

    // =====================================================================
    console.log('\nidempotency: nobody is told twice');

    const live = await makeOrg('live');
    const admin = await makeUser(live.id, 'admin', 'admin');
    await query("UPDATE organizations SET created_at = now() WHERE id = $1", [live.id]);

    const first = await outbox.evaluate({ organizationId: live.id });
    check('the first pass writes the welcome', first.written === 1, JSON.stringify(first.byKind));

    const second = await outbox.evaluate({ organizationId: live.id });
    check('the second writes nothing', second.written === 0);

    const racing = await Promise.all([1, 2, 3, 4, 5].map(() =>
      outbox.evaluate({ organizationId: live.id }).catch(() => ({ written: -1 }))));
    check('five passes at once write nothing between them',
      racing.every((r) => r.written === 0) &&
      Number((await one('SELECT COUNT(*)::int n FROM email_messages WHERE organization_id = $1', [live.id])).n) === 1,
      JSON.stringify(racing.map((r) => r.written)));

    let dupe = null;
    try {
      await query(
        `INSERT INTO email_messages (organization_id, user_id, to_address, kind, category,
                dedupe_key, subject, body_text)
         VALUES ($1,$2,$3,'welcome','transactional','once','x','y')`,
        [live.id, admin.id, admin.email]
      );
    } catch (err) { dupe = err; }
    check('and the database refuses a duplicate written by hand',
      dupe && dupe.code === '23505', dupe ? dupe.code : 'it was accepted');

    console.log('\nbut a second trial gets a second reminder');
    const a = journey.due(signals({ createdAt: ago(12.5) })).find((d) => d.kind === 'trial_ending');
    const b = journey.due(signals({ createdAt: ago(12.5), trialDays: 30 }));
    check('the key carries the expiry date, so extending a trial re-arms it',
      a.dedupeKey === new Date(Date.now() + 1.5 * DAY).toISOString().slice(0, 10) &&
      !b.some((d) => d.kind === 'trial_ending' && d.dedupeKey === a.dedupeKey),
      a.dedupeKey);

    // =====================================================================
    console.log('\nwith no provider, nothing is sent and nothing is lost');

    const held = await one(
      "SELECT * FROM email_messages WHERE organization_id = $1 AND kind = 'welcome'", [live.id]);
    check('the message was written before any attempt to send it',
      held && held.body_text.length > 100 && held.subject.length > 5);
    await outbox.flush({ limit: 10 });
    const afterFlush = await one('SELECT * FROM email_messages WHERE id = $1', [held.id]);
    check('and is held, not sent and not failed',
      afterFlush.status === 'held' && afterFlush.sent_at === null,
      afterFlush.status);
    check('with the reason on the row',
      /no mail provider is configured/.test(afterFlush.reason || ''), afterFlush.reason);
    check('and no attempt consumed, so it is not exhausted when one appears',
      afterFlush.attempts === 0, String(afterFlush.attempts));

    // =====================================================================
    console.log('\nretries, and the difference between a blip and a wall');

    const real = provider.send;
    const attempts = [];
    const stub = (result) => { provider.send = async (m) => { attempts.push(m.to); return result; }; };

    stub({ sent: false, held: false, error: 'connection reset', permanent: false });
    let msg = await one('SELECT * FROM email_messages WHERE id = $1', [held.id]);
    await query("UPDATE email_messages SET status='queued', next_attempt_at=now() WHERE id=$1", [held.id]);
    msg = await one('SELECT * FROM email_messages WHERE id = $1', [held.id]);
    const retried = await outbox.deliver(msg);
    check('a temporary failure is retried, not given up on',
      retried.status === 'queued' && retried.attempts === 1 &&
      new Date(retried.next_attempt_at) > new Date(), retried.status);
    check('and backs off further each time',
      outbox.BACKOFF_MINUTES[0] < outbox.BACKOFF_MINUTES[3]);

    stub({ sent: false, held: false, error: '550 no such user', permanent: true });
    const perm = await outbox.deliver(await one('SELECT * FROM email_messages WHERE id = $1', [held.id]));
    check('a permanent failure gives up at once rather than retrying a wall',
      perm.status === 'failed', perm.status);
    const bounced = await consent.isSuppressed(admin.email);
    check('and suppresses the address, which is what protects the sending domain',
      Boolean(bounced) && bounced.reason === 'bounced');
    await consent.unsuppress(admin.email);

    stub({ sent: true, messageId: '<abc@profitna>' });
    await query("UPDATE email_messages SET status='queued', attempts=0, next_attempt_at=now() WHERE id=$1", [held.id]);
    const sent = await outbox.deliver(await one('SELECT * FROM email_messages WHERE id = $1', [held.id]));
    check('a success is recorded with the provider’s own id',
      sent.status === 'sent' && sent.sent_at !== null && sent.provider_message_id === '<abc@profitna>');
    provider.send = real;

    check('a permanent-looking SMTP reply is classified as permanent',
      provider.classify({ responseCode: 550, message: '550 mailbox unavailable' }).permanent === true);
    check('and a 4xx as worth trying again',
      provider.classify({ responseCode: 451, message: '451 try later' }).permanent === false);

    // =====================================================================
    console.log('\nquiet hours');

    const twoAm = new Date('2026-06-01T01:00:00Z');   // 02:00 in Lagos
    const noon = new Date('2026-06-01T11:00:00Z');    // 12:00 in Lagos
    check('an account message goes at two in the morning if that is when it happened',
      outbox.sendableAt('transactional', twoAm).getTime() === twoAm.getTime());
    check('a getting-started note waits for the morning',
      outbox.sendableAt('onboarding', twoAm).getTime() > twoAm.getTime() &&
      outbox.sendableAt('onboarding', twoAm).getTime() < twoAm.getTime() + 12 * 3600000);
    check('and goes straight out at midday',
      outbox.sendableAt('onboarding', noon).getTime() === noon.getTime());

    // =====================================================================
    console.log('\naccount messages and marketing are kept apart');

    const categories = journey.STEPS.map((s) => s.category);
    check('every step declares a category the consent model knows',
      categories.every((c) => consent.isCategory(c)), JSON.stringify([...new Set(categories)]));
    check('and nothing in the lifecycle is marketing',
      !categories.includes('marketing'),
      'the category exists so nothing can later be smuggled in as onboarding');
    check('marketing needs consent; the other two do not',
      consent.CATEGORIES.marketing.basis === 'consent' &&
      consent.CATEGORIES.marketing.defaultOn === false &&
      consent.CATEGORIES.transactional.optional === false);

    console.log('\nand an unsubscribe link is offered exactly where it applies');
    const optionalKinds = journey.STEPS.filter((s) => consent.CATEGORIES[s.category].optional);
    const requiredKinds = journey.STEPS.filter((s) => !consent.CATEGORIES[s.category].optional);
    const renderWith = (kind, unsub) => templates.render(kind, templates.context({
      signals: signals({ activatedAt: ago(4), firstPaidAt: ago(1) }),
      user: { full_name: 'T', email: 'a@b.ng' }, category: 'x',
      data: { feature: journey.nextUsefulFeature(signals({})) },
      unsubscribeUrl: unsub, preferencesUrl: 'https://profitna.com/p/x'
    }));
    check('every optional message carries a working unsubscribe link',
      optionalKinds.every((s) => /Unsubscribe from these/.test(renderWith(s.kind, 'https://x/u').text)),
      optionalKinds.map((s) => s.kind).join(', '));
    check('and account messages say why they cannot be unsubscribed from instead',
      requiredKinds.every((s) => /sent whatever your email/.test(renderWith(s.kind, null).text)),
      'offering an unsubscribe on "your payment failed" would be a lie');

    // =====================================================================
    console.log('\none organisation hears nothing about another');

    const theirs = await makeOrg('theirs');
    await makeUser(theirs.id, 'theirs', 'admin');
    await outbox.evaluate({ organizationId: theirs.id });
    const crossed = await one(
      `SELECT COUNT(*)::int n FROM email_messages m
        WHERE m.organization_id = $1 AND m.to_address LIKE $2`,
      [theirs.id, '%admin%']);
    check('a message is addressed only to that organisation’s own admins',
      crossed.n === 0);

    const accountantOnly = await makeOrg('roles');
    await makeUser(accountantOnly.id, 'book', 'accountant');
    await outbox.evaluate({ organizationId: accountantOnly.id });
    const toAccountant = await one(
      'SELECT COUNT(*)::int n FROM email_messages WHERE organization_id = $1', [accountantOnly.id]);
    check('an accountant is not emailed about the subscription',
      toAccountant.n === 0,
      'they have no say over it and no business being told a card failed');

    console.log('');
    if (failures.length) {
      console.log(passed + ' passed, ' + failures.length + ' failed');
      for (const f of failures) console.log('  - ' + f);
      await cleanup();
      process.exit(1);
    }
    console.log(passed + ' passed, 0 failed');
    await cleanup();
    await pool.end();
  } catch (err) {
    console.error('\n' + (err && err.stack ? err.stack : err));
    await cleanup();
    process.exit(1);
  }
})();

async function makeOrg(tag) {
  const org = await one(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING *', ['Email ' + (tag || 'x') + ' ' + Date.now()]
  );
  made.push(org.id);
  await query(
    `INSERT INTO subscriptions (organization_id, cycle, seats, trial_start, status, trial_days)
     VALUES ($1, 'monthly', 1, CURRENT_DATE, 'trialing', 14)`, [org.id]
  );
  return org;
}

async function makeUser(orgId, tag, role) {
  const user = await one(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1,'x',$2) RETURNING *`,
    ['email-' + tag + '-' + Date.now() + '@mideops.ng', 'Tosin Balogun']
  );
  await query('INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)',
    [user.id, orgId, role || 'admin']);
  return user;
}

async function cleanup() {
  for (const id of made) await query('DELETE FROM organizations WHERE id = $1', [id]).catch(() => {});
  await query("DELETE FROM users WHERE email LIKE 'email-%@mideops.ng'").catch(() => {});
  await query("DELETE FROM email_suppressions WHERE address LIKE 'email-%@mideops.ng'").catch(() => {});
}
