// Actually putting a message on the wire.
//
// Profitna has never sent an email. Everything else in this release — the
// conditions, the idempotency, the consent, the retries — is real and runs
// now. This is the one hop that cannot, because it needs a mail provider and
// a sending domain that only the operator can arrange.
//
// So it degrades the way the rest of this product degrades: it does not
// pretend. With no provider configured, a message is rendered, recorded and
// held, with "no mail provider is configured" on the row. It is not marked
// sent, it is not thrown away, and the moment credentials appear the held
// messages are there to be looked at before anything goes out.
//
// SMTP, because every provider speaks it — Zoho, Mailgun, SendGrid, Amazon
// SES, Postmark, Resend, a plain company mailbox. One path, and the only
// thing that changes between providers is four environment variables.

const nodemailer = require('nodemailer');

// A failure that will fail again if retried, versus one that might not. The
// distinction is the whole of a sane retry policy: a wrong password retried
// four times is four more wrong passwords, and a mailbox that does not exist
// never will.
const PERMANENT = /\b(5[0-9]{2})\b|no such user|user unknown|mailbox unavailable|does not exist|invalid recipient|blocked|blacklist|authentication failed|invalid login|535|550|551|553|554/i;

function classify(err) {
  const message = (err && (err.response || err.message)) || String(err);
  const code = err && err.responseCode;
  // 4xx is explicitly "try later" in SMTP; 5xx is "do not".
  if (code && code >= 400 && code < 500) return { permanent: false, message };
  if (code && code >= 500) return { permanent: true, message };
  return { permanent: PERMANENT.test(message), message };
}

const trim = (v) => (v === undefined || v === null ? '' : String(v).trim());

function settings() {
  return {
    host: trim(process.env.EMAIL_SMTP_HOST),
    port: Number(process.env.EMAIL_SMTP_PORT || 587),
    user: trim(process.env.EMAIL_SMTP_USER),
    pass: trim(process.env.EMAIL_SMTP_PASSWORD),
    from: trim(process.env.EMAIL_FROM),
    fromName: trim(process.env.EMAIL_FROM_NAME) || 'Profitna',
    replyTo: trim(process.env.EMAIL_REPLY_TO),
    // 465 is implicit TLS; 587 is STARTTLS. Getting this wrong is the single
    // commonest SMTP misconfiguration and it fails as a timeout, which tells
    // nobody anything — so it is derived from the port rather than asked for.
    secure: Number(process.env.EMAIL_SMTP_PORT || 587) === 465
  };
}

function configured() {
  const s = settings();
  return Boolean(s.host && s.user && s.pass && s.from);
}

// What is missing, named. The operator reads this in the boot log and on
// /api/health; nothing tenant-facing ever shows it.
function requirement() {
  const s = settings();
  const missing = [];
  if (!s.host) missing.push('EMAIL_SMTP_HOST');
  if (!s.user) missing.push('EMAIL_SMTP_USER');
  if (!s.pass) missing.push('EMAIL_SMTP_PASSWORD');
  if (!s.from) missing.push('EMAIL_FROM');
  if (!missing.length) return null;
  return 'Set ' + missing.join(', ') + ' to send email. Any provider that speaks SMTP will do ' +
    '(Zoho, Mailgun, SendGrid, Amazon SES, Postmark, Resend). The sending domain needs SPF and ' +
    'DKIM records published before anything will reach an inbox rather than a spam folder.';
}

// Switched on separately from being configured.
//
// Two different questions, and keeping them apart is what makes the first
// deployment safe: credentials can be in place and proved while EMAIL_SENDING
// is still off, so the outbox fills with exactly what would have gone out and
// somebody can read it before a single customer hears from us.
const sendingEnabled = () => String(process.env.EMAIL_SENDING || 'off').toLowerCase() === 'on';

let cached = null;
let cachedFrom = null;

function transport() {
  const s = settings();
  const fingerprint = [s.host, s.port, s.user, s.secure].join('|');
  if (cached && cachedFrom === fingerprint) return cached;
  cached = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: s.pass },
    // Bounded, for the reason the payment path learned: a host that cannot
    // reach the provider must fail in seconds with a sentence, not hang.
    connectionTimeout: Number(process.env.EMAIL_TIMEOUT_MS || 15000),
    greetingTimeout: Number(process.env.EMAIL_TIMEOUT_MS || 15000),
    socketTimeout: Number(process.env.EMAIL_TIMEOUT_MS || 20000),
    // One connection, reused across a batch, rather than a handshake per
    // message. Providers rate-limit connections more aggressively than
    // messages.
    pool: true,
    maxConnections: 2,
    maxMessages: 50
  });
  cachedFrom = fingerprint;
  return cached;
}

function reset() {
  if (cached && typeof cached.close === 'function') { try { cached.close(); } catch { /* nothing to do */ } }
  cached = null;
  cachedFrom = null;
}

// Send one. Returns { sent, held, messageId, error, permanent } and never
// throws: the caller is a scheduler walking a batch, and one bad address must
// not end the pass.
async function send({ to, toName, subject, text, html, unsubscribeUrl, category, headers }) {
  if (!configured()) {
    return { sent: false, held: true, reason: 'no mail provider is configured', requirement: requirement() };
  }
  if (!sendingEnabled()) {
    return { sent: false, held: true, reason: 'sending is switched off (EMAIL_SENDING is not "on")' };
  }

  const s = settings();
  const extra = Object.assign({}, headers || {});

  // One-click unsubscribe, RFC 8058. Gmail and Yahoo both require it for bulk
  // senders now, and a provider that does not see it treats the mail as less
  // trustworthy. Only for the categories that can actually be unsubscribed
  // from: offering it on a "your payment failed" message would be a lie.
  if (unsubscribeUrl) {
    extra['List-Unsubscribe'] = '<' + unsubscribeUrl + '>';
    extra['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  // Says what this is to anything sorting mail. An account message that
  // declares itself bulk gets filed as bulk.
  extra['X-Profitna-Category'] = category || 'transactional';
  if (category && category !== 'transactional') extra.Precedence = 'bulk';

  try {
    const info = await transport().sendMail({
      from: { name: s.fromName, address: s.from },
      to: toName ? { name: toName, address: to } : to,
      replyTo: s.replyTo || undefined,
      subject,
      text,
      html,
      headers: extra
    });
    return { sent: true, messageId: info && info.messageId, accepted: info && info.accepted };
  } catch (err) {
    const { permanent, message } = classify(err);
    return { sent: false, held: false, error: message, permanent };
  }
}

// Prove the credentials without sending anything. What the operator runs
// after setting the variables, and what the health check reports.
async function verify() {
  if (!configured()) {
    const err = new Error(requirement());
    err.status = 503;
    err.code = 'NO_MAIL_PROVIDER';
    throw err;
  }
  try {
    await transport().verify();
    const s = settings();
    return { ok: true, host: s.host, port: s.port, from: s.from, sending: sendingEnabled() };
  } catch (err) {
    const { message } = classify(err);
    // 424, never 5xx: a provider refusing a credential is something being
    // deliberately reported, and the proxy in front of this app replaces a
    // 5xx body with its own page.
    const out = new Error('The mail provider refused that: ' + message);
    out.status = 424;
    out.code = 'MAIL_PROVIDER_REFUSED';
    throw out;
  }
}

// For the boot log and /api/health. Never includes the password, and the
// user is shown only as enough to spot a wrong paste.
function describe() {
  const s = settings();
  if (!configured()) return { state: 'off', requirement: requirement() };
  return {
    state: sendingEnabled() ? 'sending' : 'configured, not sending',
    host: s.host,
    port: s.port,
    from: s.from,
    user: s.user.length > 4 ? s.user.slice(0, 2) + '…' + s.user.slice(-2) : '…',
    replyTo: s.replyTo || null
  };
}

function warnings() {
  const out = [];
  if (!configured()) {
    out.push('No mail provider is configured, so automatic email is recorded but not sent. ' + requirement());
    return out;
  }
  if (!sendingEnabled()) {
    out.push('EMAIL_SENDING is not "on", so messages are rendered and held rather than sent. ' +
      'Read them at /api/admin/email before switching it on.');
  }
  const s = settings();
  if (s.port === 25) {
    out.push('EMAIL_SMTP_PORT is 25, which almost every host blocks outbound. Use 587 or 465.');
  }
  if (s.from && !/@/.test(s.from)) out.push('EMAIL_FROM is not an address.');
  return out;
}

module.exports = {
  send, verify, configured, sendingEnabled, requirement, describe, warnings,
  settings, classify, reset, PERMANENT
};
