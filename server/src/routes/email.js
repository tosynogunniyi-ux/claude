// Unsubscribing, and seeing what was sent.
//
// The unsubscribe endpoints are public and unauthenticated, because the
// person clicking is in their mail client and has no session — and demanding
// one is how an unsubscribe link turns into a spam complaint. The token in
// the path is 256 bits and identifies the person; nothing else is accepted,
// so an address cannot be enumerated and somebody else's preferences cannot
// be guessed at.

const express = require('express');
const { one, many } = require('../db');
const { requireOrg } = require('../auth');
const consent = require('../email/consent');
const templates = require('../email/templates');

const router = express.Router();

const esc = templates.esc;

// ------------------------------------------------------------------ a page
//
// Self-contained, because the person reading it arrived from an email client
// and may never have seen the app.
function page({ title, heading, body, rows, action, tone = '#0f7b4f' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; background:#F6F4EF; color:#1D2430;
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { background:#fff; border-radius:16px; padding:32px 28px; max-width:480px; width:100%;
          box-shadow:0 1px 2px rgba(16,24,40,.06),0 12px 32px rgba(16,24,40,.08); }
  .mark { width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
          font-size:21px;color:#fff;background:${tone};margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 10px; }
  p { margin:0 0 16px; color:#4B5565; }
  label { display:flex; gap:12px; align-items:flex-start; padding:12px 0; border-top:1px solid #E8E5DD; }
  label span.t { font-weight:600; display:block; }
  label span.w { font-size:13.5px; color:#6B7483; display:block; margin-top:2px; }
  input[type=checkbox] { width:18px;height:18px;margin-top:3px;accent-color:#1B2A4A;flex:0 0 18px; }
  button { border:0;background:#1B2A4A;color:#fff;border-radius:8px;padding:11px 20px;
           font-size:14px;font-weight:600;cursor:pointer;margin-top:18px; }
  a.undo { color:#4B5565; font-size:14px; }
  .note { font-size:13px;color:#8A9199;margin-top:18px; }
  .locked { opacity:.6; }
  @media (prefers-color-scheme: dark) {
    body { background:#14171C; color:#E8EAED; } .card { background:#1C2026; box-shadow:none; }
    p { color:#A9B0BA; } label { border-color:#2A2F37; } .note,a.undo { color:#6D747E; }
  }
</style></head><body><main class="card">
  <div class="mark" aria-hidden="true">✓</div>
  <h1>${esc(heading)}</h1>
  ${body}
  ${rows || ''}
  ${action || ''}
  <p class="note">Profitna — accounting and business finance for Nigerian businesses.</p>
</main></body></html>`;
}

// ------------------------------------------------------------ unsubscribing

// One click from the email. It unsubscribes immediately rather than showing a
// "are you sure" — making somebody click twice is how an unsubscribe becomes
// a spam complaint, and a complaint costs the sending reputation of every
// customer on the domain. The undo below is what makes that safe.
async function unsubscribe(req, res) {
  const category = String(req.query.c || '').trim() || null;
  try {
    const result = await consent.unsubscribeByToken(req.params.token, category);
    if (!result) {
      return res.status(200).type('html').send(page({
        title: 'Link not recognised', heading: 'That link is not one of ours', tone: '#5B6472',
        body: '<p>It may have been changed in transit, or it may belong to an account that no longer exists. ' +
          'Nothing has been altered.</p>'
      }));
    }

    const label = result.category
      ? consent.CATEGORIES[result.category].label.toLowerCase()
      : 'optional messages';
    const base = templates.baseUrl();

    return res.status(200).type('html').send(page({
      title: 'Unsubscribed',
      heading: 'Done — no more ' + label,
      body: '<p>You will not get those again.</p>' +
        '<p>We will still email you about your own account — a payment failing, your trial ' +
        'ending — because not telling you those would be worse than the email. Closing the ' +
        'account stops those too.</p>',
      action: '<p><a class="undo" href="' + esc(base + '/api/email/preferences/' + req.params.token) +
        '">Change what you hear about, or undo this</a></p>'
    }));
  } catch (err) {
    console.error('unsubscribe failed:', err.message);
    // 200 whatever happens: this page is for a person, and a 4xx or 5xx here
    // is replaced by the proxy's own error page, which tells them nothing and
    // leaves them believing they are still subscribed.
    return res.status(200).type('html').send(page({
      title: 'Something went wrong', heading: 'We could not do that just now', tone: '#9A6A00',
      body: '<p>Nothing has changed. Try the link again in a moment, or reply to any of our ' +
        'emails and a person will sort it out.</p>'
    }));
  }
}

// RFC 8058 one-click. Gmail and Yahoo both require this of bulk senders now,
// and they send a POST with no body and expect a 2xx. No page, no redirect.
async function unsubscribePost(req, res) {
  try {
    await consent.unsubscribeByToken(req.params.token, String(req.query.c || '').trim() || null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('one-click unsubscribe failed:', err.message);
    return res.status(200).json({ ok: false });
  }
}

// ------------------------------------------------------------- preferences

function preferencesPage(token, described, saved) {
  const rows = described.categories.map((c) => `
    <label class="${c.optional ? '' : 'locked'}">
      <input type="checkbox" name="${esc(c.name)}" ${c.on ? 'checked' : ''} ${c.optional ? '' : 'disabled'}>
      <span><span class="t">${esc(c.label)}</span><span class="w">${esc(c.why)}</span></span>
    </label>`).join('');

  return page({
    title: 'Email preferences',
    heading: saved ? 'Saved' : 'What would you like to hear about?',
    tone: saved ? '#0f7b4f' : '#1B2A4A',
    body: '<p>' + esc(described.note) + '</p>',
    rows: '<form method="POST" action="' + esc('/api/email/preferences/' + token) + '">' + rows +
      '<button type="submit">Save preferences</button></form>'
  });
}

async function showPreferences(req, res) {
  const prefs = await consent.byToken(req.params.token);
  if (!prefs) {
    return res.status(200).type('html').send(page({
      title: 'Link not recognised', heading: 'That link is not one of ours', tone: '#5B6472',
      body: '<p>Nothing has been altered.</p>'
    }));
  }
  return res.status(200).type('html').send(
    preferencesPage(req.params.token, consent.describe(prefs), false)
  );
}

async function savePreferences(req, res) {
  const prefs = await consent.byToken(req.params.token);
  if (!prefs) {
    return res.status(200).type('html').send(page({
      title: 'Link not recognised', heading: 'That link is not one of ours', tone: '#5B6472',
      body: '<p>Nothing has been altered.</p>'
    }));
  }
  const body = req.body || {};
  // An unchecked box sends nothing at all, which is how an HTML form says
  // false. Only the optional categories are read; the account one is not
  // offered and is not accepted even if somebody posts it.
  const updated = await consent.update(prefs.user_id, {
    onboarding: body.onboarding !== undefined,
    marketing: body.marketing !== undefined,
    // Turning either back on is also an undo of "everything off".
    allOff: body.onboarding === undefined && body.marketing === undefined
  }, 'preferences page');

  return res.status(200).type('html').send(
    preferencesPage(req.params.token, consent.describe(updated), true)
  );
}

router.get('/unsubscribe/:token', unsubscribe);
router.post('/unsubscribe/:token', unsubscribePost);
router.get('/preferences/:token', showPreferences);
router.post('/preferences/:token', express.urlencoded({ extended: false }), savePreferences);

// ------------------------------------------------- what an account was sent
//
// Org-scoped and admin-only. A business can see what Profitna has emailed
// them, which is the least they are owed and the fastest way to answer "I
// never got that".

const orgRouter = express.Router({ mergeParams: true });

orgRouter.get('/email', requireOrg('admin'), async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT m.id, m.kind, m.category, m.subject, m.to_address, m.status, m.reason,
              m.attempts, m.last_error, m.sent_at, m.created_at
         FROM email_messages m
        WHERE m.organization_id = $1
        ORDER BY m.created_at DESC LIMIT 100`,
      [req.orgId]
    );
    res.json({
      messages: rows.map((r) => ({
        id: r.id, kind: r.kind, category: r.category, subject: r.subject,
        to: r.to_address, status: r.status, reason: r.reason,
        attempts: r.attempts, error: r.last_error,
        sentAt: r.sent_at, createdAt: r.created_at
      })),
      // Said plainly rather than left to be worked out from an empty list.
      note: rows.length ? null : 'Nothing has been emailed about this account yet.'
    });
  } catch (err) { next(err); }
});

// One message, as it was written. For the business that wants to read what
// they were actually sent.
orgRouter.get('/email/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await one(
      'SELECT * FROM email_messages WHERE organization_id = $1 AND id = $2',
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such message.' });
    if (String(req.query.format) === 'html' && row.body_html) {
      return res.type('html').send(row.body_html);
    }
    res.json({
      kind: row.kind, category: row.category, subject: row.subject,
      to: row.to_address, status: row.status, reason: row.reason,
      text: row.body_text, sentAt: row.sent_at, createdAt: row.created_at
    });
  } catch (err) { next(err); }
});

module.exports = { router, orgRouter, page, unsubscribe, unsubscribePost };
