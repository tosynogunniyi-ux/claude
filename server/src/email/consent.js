// What may be sent to whom, and what must never be sent again.
//
// Two separate questions, and conflating them is the usual mistake:
//
//   What has this person agreed to receive? That is about the person, it is
//   per category, and they can change it.
//
//   Is this address safe to send to at all? That is about the mailbox. A hard
//   bounce or a spam complaint belongs to the address, outlives the account,
//   and overrides every preference including the ones that cannot otherwise
//   be switched off. Continuing to send to an address that bounced or to
//   somebody who reported you is how a sending domain's reputation is
//   destroyed — and the reputation is shared by every customer on it.

const crypto = require('crypto');
const { one, many, query } = require('../db');

// The three classes, and why each is allowed.
//
// The distinction is not cosmetic. Under the NDPR, messages necessary to
// perform a contract with the person stand on a different footing from
// messages sent to market to them, and only the second needs consent. Putting
// a sales message in the first bucket because it is convenient is precisely
// the thing the rule exists to stop, so the categories are declared here with
// their justification attached and the sender will not send a message whose
// category it does not recognise.
const CATEGORIES = {
  transactional: {
    label: 'About your account',
    basis: 'contract',
    why: 'Your trial ending, a payment failing, your account status changing. ' +
      'These are about the account you hold with us.',
    // Cannot be switched off, and the preferences screen says so rather than
    // offering a switch that does nothing. Somebody who stops these stops
    // learning that their card failed, which is not a kindness. The way to
    // stop them is to close the account.
    optional: false,
    defaultOn: true
  },
  onboarding: {
    label: 'Help getting started',
    basis: 'legitimate interest',
    why: 'Short notes about using the part of Profitna you have not reached yet. ' +
      'They stop on their own once you are up and running.',
    optional: true,
    defaultOn: true
  },
  marketing: {
    label: 'News and offers',
    basis: 'consent',
    why: 'New features, pricing, anything we are selling.',
    optional: true,
    // Off until somebody deliberately turns it on. Nothing in the lifecycle
    // journey is in this category; it exists so that nothing can later be
    // added to the journey and quietly treated as onboarding.
    defaultOn: false
  }
};

const NAMES = Object.keys(CATEGORIES);

const isCategory = (c) => Object.prototype.hasOwnProperty.call(CATEGORIES, String(c));

const normalise = (address) => String(address || '').trim().toLowerCase();

// A plausible address. Not an attempt to implement RFC 5322 — the only
// question worth answering here is whether sending to it is going to bounce
// and cost reputation, and the shapes below are the ones that always do.
function deliverable(address) {
  const a = normalise(address);
  if (!a || a.length > 254) return false;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(a)) return false;
  if (/\.\./.test(a) || a.startsWith('.') || a.includes('@.')) return false;
  return true;
}

// ------------------------------------------------------------- preferences

// The row, created on first use with a token of its own. Idempotent, so it is
// safe to call on every send and from the signup path.
async function ensure(userId) {
  await query(
    `INSERT INTO email_preferences (user_id, unsubscribe_token)
     VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, crypto.randomBytes(32).toString('hex')]
  );
  return one('SELECT * FROM email_preferences WHERE user_id = $1', [userId]);
}

const forUser = (userId) => one('SELECT * FROM email_preferences WHERE user_id = $1', [userId]);

const byToken = (token) => (/^[0-9a-f]{64}$/.test(String(token || ''))
  ? one('SELECT * FROM email_preferences WHERE unsubscribe_token = $1', [token])
  : Promise.resolve(null));

// ------------------------------------------------------------- suppression

async function isSuppressed(address) {
  const row = await one(
    `SELECT * FROM email_suppressions
      WHERE address = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [normalise(address)]
  );
  return row || null;
}

// A soft bounce — a full mailbox, a server having a bad afternoon — expires
// and the address comes back. A hard one does not, and neither does a
// complaint: somebody who pressed "this is spam" has said something clearer
// than any preference screen could capture.
async function suppress(address, reason, detail, { hours } = {}) {
  const expires = hours ? new Date(Date.now() + hours * 3600000).toISOString() : null;
  return one(
    `INSERT INTO email_suppressions (address, reason, detail, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (address) DO UPDATE
       SET reason = EXCLUDED.reason, detail = EXCLUDED.detail,
           -- A permanent suppression is never downgraded to a temporary one
           -- by a later soft bounce.
           expires_at = CASE WHEN email_suppressions.expires_at IS NULL THEN NULL
                             ELSE EXCLUDED.expires_at END
     RETURNING *`,
    [normalise(address), reason, detail ? String(detail).slice(0, 500) : null, expires]
  );
}

const unsuppress = (address) =>
  query('DELETE FROM email_suppressions WHERE address = $1', [normalise(address)]);

// ------------------------------------------------------------- the decision

// May this message go to this person at this address?
//
// Returns a reason rather than a boolean, because every refusal is written
// into the outbox and "no" on its own is not something anybody can act on.
function decide({ category, preferences, address, suppression }) {
  if (!isCategory(category)) {
    return { ok: false, status: 'cancelled', reason: 'unknown category "' + category + '"' };
  }
  if (!deliverable(address)) {
    return { ok: false, status: 'suppressed', reason: 'that is not a deliverable address' };
  }
  if (suppression) {
    return {
      ok: false,
      status: 'suppressed',
      reason: suppression.reason === 'complained'
        ? 'this address reported us as spam'
        : suppression.reason === 'bounced'
          ? 'this address has bounced'
          : 'this address is suppressed (' + suppression.reason + ')'
    };
  }

  const prefs = preferences || {};
  const rule = CATEGORIES[category];

  // Everything off, by their own choice. It stops the optional categories and
  // not the account ones — somebody who clicks "unsubscribe from everything"
  // on a getting-started email has not asked to stop being told their card
  // failed, and treating it as though they had would be the more harmful
  // reading. The preferences page says this in as many words.
  if (prefs.all_off && rule.optional) {
    return { ok: false, status: 'cancelled', reason: 'unsubscribed from everything' };
  }

  if (rule.optional && prefs[category] === false) {
    return { ok: false, status: 'cancelled', reason: 'opted out of ' + category };
  }

  // Marketing is the one that is off unless it was deliberately turned on. A
  // missing preferences row is not consent.
  if (category === 'marketing' && prefs.marketing !== true) {
    return { ok: false, status: 'cancelled', reason: 'no marketing consent on record' };
  }

  if (category === 'transactional' && prefs.transactional === false) {
    return { ok: false, status: 'cancelled', reason: 'account emails are disabled for this user' };
  }

  return { ok: true };
}

// ------------------------------------------------------------- changing it

async function update(userId, patch, source) {
  await ensure(userId);
  const sets = [];
  const args = [userId];
  const add = (sql, v) => { args.push(v); sets.push(sql.replace('$n', '$' + args.length)); };

  if (patch.onboarding !== undefined) add('onboarding = $n', Boolean(patch.onboarding));
  if (patch.marketing !== undefined) {
    const on = Boolean(patch.marketing);
    add('marketing = $n', on);
    // The record of consent, not just the flag. "They ticked a box" is not an
    // answer to a complaint; when and from where is.
    if (on) {
      sets.push('marketing_consent_at = now()');
      add('marketing_consent_source = $n', String(source || 'preferences').slice(0, 120));
    } else {
      sets.push('marketing_consent_at = NULL');
    }
  }
  // Turning any optional category back on contradicts "unsubscribed from
  // everything", and a row that says both is a row decide() reads as blocked
  // while the screen shows it as on. Whichever the person did last wins, and
  // the one they did last is this one.
  if (patch.onboarding === true || patch.marketing === true) {
    sets.push('all_off = false', 'all_off_at = NULL');
  }

  if (patch.allOff !== undefined) {
    const off = Boolean(patch.allOff);
    add('all_off = $n', off);
    sets.push(off ? 'all_off_at = now()' : 'all_off_at = NULL');
    // Turning everything off turns the optional categories off with it, so
    // the row cannot say "subscribed to onboarding" and "unsubscribed from
    // everything" at the same time.
    if (off) sets.push('onboarding = false', 'marketing = false', 'marketing_consent_at = NULL');
  }
  if (!sets.length) return forUser(userId);

  sets.push('updated_at = now()');
  return one(
    'UPDATE email_preferences SET ' + sets.join(', ') + ' WHERE user_id = $1 RETURNING *', args
  );
}

// One click, from a link in a message. `category` narrows it; without one it
// is everything optional.
async function unsubscribeByToken(token, category) {
  const prefs = await byToken(token);
  if (!prefs) return null;

  if (category && isCategory(category) && CATEGORIES[category].optional) {
    return { prefs: await update(prefs.user_id, { [category]: false }, 'one-click'), category };
  }
  return { prefs: await update(prefs.user_id, { allOff: true }, 'one-click'), category: null };
}

// What the preferences screen shows: the categories, what each is for, which
// can be changed, and the honest sentence about the one that cannot.
function describe(prefs) {
  const p = prefs || {};
  return {
    categories: NAMES.map((name) => ({
      name,
      label: CATEGORIES[name].label,
      why: CATEGORIES[name].why,
      basis: CATEGORIES[name].basis,
      optional: CATEGORIES[name].optional,
      on: CATEGORIES[name].optional
        ? (p.all_off ? false : p[name] === true || (p[name] === undefined && CATEGORIES[name].defaultOn))
        : p[name] !== false
    })),
    allOff: Boolean(p.all_off),
    marketingConsentAt: p.marketing_consent_at || null,
    note: 'Turning everything off stops the optional messages. We will still email you ' +
      'about your own account — a payment failing, your trial ending — because not ' +
      'telling you those would be worse. Closing the account stops those too.'
  };
}

module.exports = {
  CATEGORIES, NAMES, isCategory, normalise, deliverable,
  ensure, forUser, byToken, update, unsubscribeByToken, describe,
  isSuppressed, suppress, unsuppress, decide
};
