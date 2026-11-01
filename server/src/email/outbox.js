// Deciding, recording, and sending.
//
// The order matters and is not negotiable: a message is written down before
// any attempt is made to send it. So the outbox holds the ones that went, the
// ones that failed, the ones held because the address bounced last month, and
// the ones rendered while sending was switched off — with the reason on each.
// "We have no record of that" is the worst answer to give somebody asking
// what you emailed them, and it is the answer you get from a system that
// sends first and logs afterwards.

const { pool, one, many, query } = require('../db');
const consent = require('./consent');
const provider = require('./provider');
const templates = require('./templates');
const journey = require('./journey');

const MAX_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS || 5);

// Five tries over about a day and a half, widening each time. A mail server
// having a bad minute is recovered from; one having a bad afternoon is too.
// Past that it is not a blip and retrying is just noise in somebody's queue.
const BACKOFF_MINUTES = [5, 30, 120, 480, 1440];

// Nothing optional lands at three in the morning. A message about somebody's
// own account — their card just failed — goes when it happens, because the
// point of it is that it is timely.
const QUIET = {
  // West Africa Time, which is what every recipient of this product is on.
  offsetHours: 1,
  from: 8,
  to: 20
};

function sendableAt(category, now) {
  const at = new Date(now || Date.now());
  if (category === 'transactional') return at;

  const local = new Date(at.getTime() + QUIET.offsetHours * 3600000);
  const hour = local.getUTCHours();
  if (hour >= QUIET.from && hour < QUIET.to) return at;

  // Next 08:00 local, expressed back in UTC.
  const next = new Date(local);
  if (hour >= QUIET.to) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(QUIET.from, Math.floor(Math.random() * 20), 0, 0);
  return new Date(next.getTime() - QUIET.offsetHours * 3600000);
}

// --------------------------------------------------------------- recipients

// Who hears about an organisation's account. Admins — an accountant or a
// viewer has no say over the subscription and no business being told a card
// failed. Suspended or deactivated users are skipped: they have been removed
// from the account and should stop hearing from it.
function adminsOf(organizationId) {
  return many(
    `SELECT u.id, u.email, u.full_name, u.status
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE m.organization_id = $1 AND m.role = 'admin'
        AND (u.status IS NULL OR u.status = 'active')
      ORDER BY m.created_at`,
    [organizationId]
  );
}

// --------------------------------------------------------------- recording

// Write one message down. The unique index decides whether it is new: two
// containers evaluating the same organisation in the same second both insert,
// and exactly one row results.
async function record(row) {
  const inserted = await one(
    `INSERT INTO email_messages
       (organization_id, user_id, to_address, to_name, kind, category, dedupe_key,
        subject, body_text, body_html, status, reason, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (organization_id, kind, dedupe_key, user_id) DO NOTHING
     RETURNING *`,
    [row.organizationId, row.userId, row.toAddress, row.toName, row.kind, row.category,
      row.dedupeKey, row.subject, row.text, row.html, row.status, row.reason || null,
      row.sendAt || new Date().toISOString()]
  );
  return inserted || null;
}

// Decide one step for one person: may it be sent, what does it say, and what
// state does it go into. Returns the row written, or null if it had already
// been written.
async function consider({ signals, step, user, now }) {
  const prefs = await consent.ensure(user.id);
  const address = consent.normalise(user.email);
  const suppression = await consent.isSuppressed(address);

  const verdict = consent.decide({
    category: step.category, preferences: prefs, address, suppression
  });

  const optional = consent.CATEGORIES[step.category] &&
    consent.CATEGORIES[step.category].optional;
  const base = templates.baseUrl();
  const unsubscribeUrl = optional
    ? base + '/api/email/unsubscribe/' + prefs.unsubscribe_token + '?c=' + step.category
    : null;
  const preferencesUrl = base + '/api/email/preferences/' + prefs.unsubscribe_token;

  // Rendered even when it will not be sent. The outbox is then a record of
  // what we would have said, which is the thing worth being able to read
  // before switching sending on for the first time.
  const rendered = templates.render(step.kind, templates.context({
    signals, user, category: step.category, data: step.data,
    unsubscribeUrl, preferencesUrl
  }));

  return record({
    organizationId: signals.organizationId,
    userId: user.id,
    toAddress: address,
    toName: user.full_name,
    kind: step.kind,
    category: step.category,
    dedupeKey: step.dedupeKey,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    status: verdict.ok ? 'queued' : verdict.status,
    reason: verdict.ok ? null : verdict.reason,
    sendAt: verdict.ok ? sendableAt(step.category, now).toISOString() : new Date().toISOString()
  });
}

// --------------------------------------------------------------- delivering

async function deliver(message) {
  const prefs = message.user_id ? await consent.forUser(message.user_id) : null;
  const optional = consent.CATEGORIES[message.category] &&
    consent.CATEGORIES[message.category].optional;

  const result = await provider.send({
    to: message.to_address,
    toName: message.to_name,
    subject: message.subject,
    text: message.body_text,
    html: message.body_html,
    category: message.category,
    unsubscribeUrl: optional && prefs
      ? templates.baseUrl() + '/api/email/unsubscribe/' + prefs.unsubscribe_token + '?c=' + message.category
      : null
  });

  if (result.sent) {
    return one(
      `UPDATE email_messages
          SET status = 'sent', sent_at = now(), attempts = attempts + 1,
              last_attempt_at = now(), last_error = NULL, reason = NULL,
              provider = 'smtp', provider_message_id = $2
        WHERE id = $1 RETURNING *`,
      [message.id, result.messageId || null]
    );
  }

  // Held: nothing is wrong, there is just nowhere to send it yet. Not an
  // attempt, so it does not consume one — the moment a provider is configured
  // these go out rather than arriving already exhausted.
  if (result.held) {
    return one(
      `UPDATE email_messages
          SET status = 'held', reason = $2, next_attempt_at = now() + interval '1 hour'
        WHERE id = $1 RETURNING *`,
      [message.id, result.reason]
    );
  }

  const attempts = Number(message.attempts) + 1;

  // A wrong password retried four times is four more wrong passwords, and a
  // mailbox that does not exist never will. A permanent failure stops now and
  // suppresses the address, which is also what keeps the sending domain's
  // reputation intact.
  if (result.permanent || attempts >= MAX_ATTEMPTS) {
    if (result.permanent) {
      await consent.suppress(message.to_address, 'bounced', result.error);
      await query(
        `INSERT INTO email_events (message_id, address, event, detail) VALUES ($1,$2,'bounced',$3)`,
        [message.id, message.to_address, String(result.error).slice(0, 500)]
      );
    }
    return one(
      `UPDATE email_messages
          SET status = 'failed', attempts = $2, last_attempt_at = now(), last_error = $3,
              reason = $4
        WHERE id = $1 RETURNING *`,
      [message.id, attempts, String(result.error).slice(0, 500),
        result.permanent ? 'the address rejected it permanently' : 'gave up after ' + attempts + ' attempts']
    );
  }

  const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
  return one(
    `UPDATE email_messages
        SET attempts = $2, last_attempt_at = now(), last_error = $3,
            next_attempt_at = now() + ($4 || ' minutes')::interval
      WHERE id = $1 RETURNING *`,
    [message.id, attempts, String(result.error).slice(0, 500), String(wait)]
  );
}

// --------------------------------------------------------------- the pass

// Evaluate the journey for every organisation that could have something due,
// and write down whatever qualifies. Sends nothing — that is the next step,
// deliberately separate so the deciding can be run and inspected on its own.
async function evaluate({ at, organizationId, limit } = {}) {
  const now = at ? new Date(at) : new Date();
  const orgs = organizationId
    ? [await journey.signalsFor(organizationId)].filter(Boolean)
    : await journey.candidates({ limit });

  const out = { organisations: orgs.length, considered: 0, written: 0, byKind: {}, failed: [] };

  for (const signals of orgs) {
    let steps = [];
    try {
      steps = journey.due(signals, now);
    } catch (err) {
      out.failed.push({ organization: signals.organizationId, error: err.message });
      continue;
    }
    if (!steps.length) continue;

    let people = [];
    try {
      people = await adminsOf(signals.organizationId);
    } catch (err) {
      out.failed.push({ organization: signals.organizationId, error: err.message });
      continue;
    }

    for (const step of steps) {
      for (const user of people) {
        out.considered++;
        try {
          const written = await consider({ signals, step, user, now });
          if (written) {
            out.written++;
            out.byKind[step.kind] = (out.byKind[step.kind] || 0) + 1;
          }
        } catch (err) {
          // One organisation's odd row must not stop every other business
          // hearing that their trial is ending.
          out.failed.push({
            organization: signals.organizationId, kind: step.kind, error: err.message
          });
        }
      }
    }
  }
  return out;
}

// Send what is queued and due. Separate from evaluate() so each can be run,
// tested and reasoned about alone.
async function flush({ limit = 50 } = {}) {
  const batch = await many(
    `SELECT * FROM email_messages
      WHERE status IN ('queued', 'held') AND next_attempt_at <= now()
      ORDER BY
        -- An account message goes before a getting-started note when both are
        -- waiting. Somebody's card failing matters more than a feature tip.
        CASE WHEN category = 'transactional' THEN 0 ELSE 1 END,
        next_attempt_at
      LIMIT $1`,
    [Math.min(Number(limit) || 50, 500)]
  );

  const out = { looked: batch.length, sent: 0, held: 0, retrying: 0, failed: 0 };
  for (const message of batch) {
    try {
      const after = await deliver(message);
      if (!after) continue;
      if (after.status === 'sent') out.sent++;
      else if (after.status === 'held') out.held++;
      else if (after.status === 'failed') out.failed++;
      else out.retrying++;
    } catch (err) {
      out.failed++;
      console.error('email: delivering ' + message.id + ' threw: ' + err.message);
      await query(
        `UPDATE email_messages SET attempts = attempts + 1, last_attempt_at = now(),
                last_error = $2, next_attempt_at = now() + interval '30 minutes'
          WHERE id = $1`,
        [message.id, String(err.message).slice(0, 500)]
      ).catch(() => {});
    }
  }
  return out;
}

// Cancel anything queued that should no longer go — belt and braces beside
// the conditions, which already decline to re-qualify. Used when a payment
// confirms, so a trial reminder that was queued at 23:00 for 08:00 does not
// arrive after the money has already been taken.
async function cancelTrialReminders(organizationId, why) {
  const rows = await many(
    `UPDATE email_messages
        SET status = 'cancelled', reason = $2
      WHERE organization_id = $1
        AND status IN ('queued', 'held')
        AND kind IN ('trial_status', 'trial_ending', 'trial_ended', 'activation_offer', 'setup_help')
      RETURNING id, kind`,
    [organizationId, String(why || 'no longer applies').slice(0, 200)]
  );
  return rows;
}

module.exports = {
  evaluate, flush, deliver, consider, record, adminsOf,
  cancelTrialReminders, sendableAt,
  MAX_ATTEMPTS, BACKOFF_MINUTES, QUIET
};
