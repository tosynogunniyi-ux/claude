// The messages.
//
// Written to be read by somebody running a business in Lagos who has thirty
// seconds, not by a marketer. So: one idea per message, the specific next
// thing to do, no exclamation marks, no "we noticed you haven't…", and never
// a claim the product cannot back up.
//
// Every message is rendered to both plain text and HTML. The text part is not
// a courtesy — a message with no text alternative scores worse with every
// spam filter there is, and some people read mail as text on purpose.
//
// Each template returns { subject, text, html }. Nothing here decides whether
// to send: that is journey.js, and keeping the two apart is what makes the
// conditions testable without rendering and the wording changeable without
// touching the conditions.

const money = require('../money');

const BRAND = {
  cream: '#F6F4EF',
  ink: '#1A1A1A',
  body: '#403D37',
  muted: '#5C5850',
  navy: '#1B2A4A',
  gold: '#FAC775',
  rule: '#E5E1D8'
};

function baseUrl() {
  const raw = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || 'https://profitna.com';
  return String(raw).replace(/\/+$/, '');
}

const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'there';

const theDate = (d) => new Date(d).toLocaleDateString('en-NG', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos'
});

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// ------------------------------------------------------------- the wrapper

// One layout. Inline styles only, a single column, nothing that needs a
// stylesheet — because half of email clients discard <style> blocks and the
// other half disagree about what is left.
function wrap({ heading, blocks, action, footerNote, unsubscribeUrl, preferencesUrl, category }) {
  const button = action
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${esc(action.href)}" style="display:inline-block;background:${BRAND.navy};color:#FFFFFF;text-decoration:none;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:600;">${esc(action.label)}</a>
       </td></tr>`
    : '';

  const paragraphs = blocks.map((b) => {
    if (b.type === 'facts') {
      return `<tr><td style="padding:4px 0 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#FFFFFF;border:1px solid ${BRAND.rule};border-radius:6px;width:100%;">
          ${b.rows.map((r) => `<tr>
            <td style="padding:10px 14px;font-size:14px;color:${BRAND.muted};border-bottom:1px solid #F2EFE8;">${esc(r[0])}</td>
            <td style="padding:10px 14px;font-size:14px;color:${BRAND.ink};font-weight:600;text-align:right;border-bottom:1px solid #F2EFE8;">${esc(r[1])}</td>
          </tr>`).join('')}
        </table></td></tr>`;
    }
    return `<tr><td style="padding:0 0 14px;font-size:15px;line-height:1.6;color:${BRAND.body};">${b.html || esc(b.text)}</td></tr>`;
  }).join('');

  // The unsubscribe line is not decoration. For an optional category it has
  // to be there, it has to work in one click, and it has to be findable —
  // which means readable, not 8px grey on cream.
  const unsub = unsubscribeUrl
    ? `<p style="margin:0 0 6px;">You are getting this because you signed up for Profitna.
         <a href="${esc(unsubscribeUrl)}" style="color:${BRAND.muted};">Unsubscribe from these</a>
         or <a href="${esc(preferencesUrl)}" style="color:${BRAND.muted};">choose what you hear about</a>.</p>`
    : `<p style="margin:0 0 6px;">This is a message about your Profitna account, so it is sent whatever
         your email preferences are. You can
         <a href="${esc(preferencesUrl)}" style="color:${BRAND.muted};">change those here</a>.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BRAND.cream};">
<tr><td align="center" style="padding:28px 16px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 20px;">
      <span style="font-size:17px;font-weight:700;letter-spacing:0.08em;color:${BRAND.ink};">PROFIT<span style="color:#B8863A;">NA</span></span>
    </td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid ${BRAND.rule};border-top:3px solid ${BRAND.gold};border-radius:8px;padding:28px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr><td style="padding:0 0 14px;font-size:21px;font-weight:700;color:${BRAND.ink};line-height:1.3;">${esc(heading)}</td></tr>
        ${paragraphs}
        ${button}
      </table>
    </td></tr>
    <tr><td style="padding:18px 4px 0;font-size:12.5px;line-height:1.55;color:${BRAND.muted};">
      ${footerNote ? `<p style="margin:0 0 10px;">${esc(footerNote)}</p>` : ''}
      ${unsub}
      <p style="margin:0;color:#8A857C;">Profitna — accounting and business finance for Nigerian businesses. Lagos, Nigeria.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function plain({ heading, blocks, action, footerNote, unsubscribeUrl, preferencesUrl }) {
  const parts = [heading, ''];
  for (const b of blocks) {
    if (b.type === 'facts') {
      for (const r of b.rows) parts.push('  ' + r[0] + ': ' + r[1]);
      parts.push('');
    } else {
      parts.push(b.text, '');
    }
  }
  if (action) parts.push(action.label + ': ' + action.href, '');
  if (footerNote) parts.push(footerNote, '');
  parts.push(unsubscribeUrl
    ? 'Unsubscribe from these: ' + unsubscribeUrl + '\nChoose what you hear about: ' + preferencesUrl
    : 'This is a message about your Profitna account, so it is sent whatever your email\n' +
      'preferences are. Change those here: ' + preferencesUrl);
  parts.push('', 'Profitna — accounting and business finance for Nigerian businesses. Lagos, Nigeria.');
  return parts.join('\n');
}

// ------------------------------------------------------------- the messages

const TEMPLATES = {
  welcome: (c) => ({
    subject: 'Your Profitna account is ready',
    heading: 'Welcome, ' + firstName(c.user.full_name),
    blocks: [
      { text: c.organizationName + ' is set up and your ' + c.signals.trialDays +
        '-day trial has started. No card was needed and none is on file.' },
      { text: 'The quickest way to see whether Profitna suits you is to put one real thing in it ' +
        '— one payment you made this week, or one invoice you need to send. Everything else ' +
        '(the reports, the VAT summary, the balance sheet) is built from what you record, so ' +
        'one entry is enough to see it working.' },
      { type: 'facts', rows: [
        ['Your books', c.organizationName],
        ['Trial ends', theDate(c.signals.trialEnd)],
        ['Cost during the trial', 'Nothing']
      ] }
    ],
    action: { label: 'Open your books', href: baseUrl() },
    footerNote: 'Nothing is deleted when a trial ends. Your books wait for you.'
  }),

  setup_help: (c) => ({
    subject: 'Getting the first thing into Profitna',
    heading: 'The first entry is the hard one',
    blocks: [
      { text: 'You set up ' + c.organizationName + ' yesterday and there is nothing in it yet. ' +
        'That is normal — people usually stall at the same place, which is wondering where to start.' },
      { text: 'Start with the last payment you made. Not the full month, not the whole year. One ' +
        'payment: what it was for, how much, and who to. It takes about twenty seconds and it ' +
        'turns the dashboard from an empty shape into your actual numbers.' },
      { text: 'If what is stopping you is a pile of bank statements, you can import them instead — ' +
        'CSV, Excel or a Google Sheet — and categorise them afterwards.' }
    ],
    action: { label: 'Record one entry', href: baseUrl() },
    footerNote: 'If Profitna is not what you were after, you can ignore this and the trial will simply end.'
  }),

  activation_offer: (c) => ({
    subject: 'Would it help if we set it up with you?',
    heading: 'Three days in, and still a blank set of books',
    blocks: [
      { text: 'There is no judgement in this — most accounting software is abandoned in the first ' +
        'week because the setup is the whole job and nobody has an afternoon spare.' },
      { text: 'Two things that usually unstick it. One: import a bank statement rather than typing ' +
        'anything. Profitna reads CSV, Excel and Google Sheets, suggests a category for each line, ' +
        'and you correct the ones it got wrong. Two: if your books are the kind that will not ' +
        'import cleanly, reply to this message and tell us what you are looking at.' },
      { text: 'Your trial runs to ' + theDate(c.signals.trialEnd) + ', so there is time either way.' }
    ],
    action: { label: 'Import a statement', href: baseUrl() }
  }),

  feature_guidance: (c) => ({
    subject: c.data.feature.title,
    heading: c.data.feature.title,
    blocks: [
      { text: 'You have been using Profitna for about a week, and this is the one thing most ' +
        'businesses at your stage have not reached yet.' },
      { text: c.data.feature.body }
    ],
    action: { label: 'Have a look', href: baseUrl() },
    footerNote: 'One note like this, when it is relevant. Not a weekly newsletter.'
  }),

  trial_status: (c) => ({
    subject: 'Where your trial stands',
    heading: plural(c.daysLeft, 'day', 'days') + ' left on your trial',
    blocks: [
      { text: 'You have been using ' + c.organizationName + ' for ten days. This is the plain ' +
        'version of where things stand, so the end of the trial does not arrive as a surprise.' },
      { type: 'facts', rows: [
        ['Trial ends', theDate(c.signals.trialEnd)],
        ['Plan', c.planLine],
        ['Card on file', 'None']
      ] },
      { text: 'When the trial ends the books close behind a payment screen and nothing is deleted. ' +
        'Your organisation, your ledger, your invoices and every figure stay exactly where they ' +
        'are and come back the moment payment goes through.' },
      { text: 'Paying before the trial ends does not cost you the remaining days — the paid term ' +
        'starts when the trial would have ended.' }
    ],
    action: { label: 'See the plan', href: baseUrl() + '/#settings' }
  }),

  trial_ending: (c) => ({
    subject: 'Your trial ends ' + theDate(c.signals.trialEnd),
    heading: 'Your trial ends in ' + plural(c.hoursLeft < 36 ? 1 : 2, 'day', 'days'),
    blocks: [
      { text: 'This is the reminder, not a sales message. On ' + theDate(c.signals.trialEnd) +
        ' the books for ' + c.organizationName + ' close behind a payment screen.' },
      { type: 'facts', rows: [
        ['Trial ends', theDate(c.signals.trialEnd)],
        ['Then', c.planLine],
        ['What happens to your data', 'Nothing. It waits for you.']
      ] },
      { text: 'Nothing is deleted and nothing is charged automatically — there is no card on file. ' +
        'If you do nothing, the account simply closes and reopens whenever you come back.' }
    ],
    action: { label: 'Continue with Profitna', href: baseUrl() + '/#settings' }
  }),

  trial_ended: (c) => ({
    subject: 'Your trial has ended',
    heading: 'Your trial has ended',
    blocks: [
      { text: 'The trial for ' + c.organizationName + ' ended on ' + theDate(c.signals.trialEnd) +
        '. The books are closed behind a payment screen.' },
      { text: 'Nothing has been deleted. Every transaction, invoice, bill and report is exactly ' +
        'where you left it, and all of it comes back the moment payment goes through. There is ' +
        'no deadline on that and no card on file, so nothing will be charged unless you choose it.' },
      { type: 'facts', rows: [
        ['Your books', c.organizationName],
        ['To continue', c.planLine]
      ] }
    ],
    action: { label: 'Reopen your books', href: baseUrl() + '/#settings' }
  }),

  paid_welcome: (c) => ({
    subject: 'Payment received — your books are open',
    heading: 'Thank you. Everything is open.',
    blocks: [
      { text: 'Your payment for ' + c.organizationName + ' went through and the account is active. ' +
        'Nothing is behind a payment screen any more.' },
      { type: 'facts', rows: [
        ['Plan', c.planLine],
        ['Next charge', c.signals.periodEnd ? theDate(c.signals.periodEnd) : 'at the end of this term'],
        ['Card', c.signals.card ? c.signals.card.brand + ' ending ' + c.signals.card.last4 : 'none kept']
      ].concat(c.signals.card ? [] : [['Note', 'No card was kept, so renewal will need another payment']]) },
      { text: 'Three things worth knowing now that you are set up. Your reports are already written ' +
        '— profit and loss, balance sheet, trial balance and a VAT summary, all built from what ' +
        'you record. You can invite your accountant as a viewer without giving up control. And ' +
        'every invoice you issue posts itself to the books, so the two can never disagree.' }
    ],
    action: { label: 'Open your books', href: baseUrl() }
  }),

  paid_settling_in: (c) => ({
    subject: 'A week in: ' + c.data.feature.title.toLowerCase(),
    heading: c.data.feature.title,
    blocks: [
      { text: 'You have had a week on the paid plan. This is the one thing worth adding next, ' +
        'based on what is already in your books.' },
      { text: c.data.feature.body },
      { text: 'If something is not working the way you expected, reply to this message. It goes ' +
        'to a person.' }
    ],
    action: { label: 'Have a look', href: baseUrl() },
    footerNote: 'This is the last of the getting-started notes.'
  }),

  payment_failed: (c) => ({
    subject: 'Your payment did not go through',
    heading: 'We could not take that payment',
    blocks: [
      { text: 'The payment for ' + c.organizationName + ' was declined. This is almost always the ' +
        'bank rather than anything wrong with the account — an expired card, a daily limit, or ' +
        'a card not enabled for recurring charges.' },
      { type: 'facts', rows: [
        ['Card', c.signals.card ? c.signals.card.brand + ' ending ' + c.signals.card.last4 : 'on file'],
        ['Amount', c.amountLine],
        ['What the bank said', c.signals.lastChargeError || 'declined, with no reason given'],
        ['Next attempt', c.nextAttemptLine]
      ] },
      { text: 'Your books are still open and nothing has changed. We will try again automatically. ' +
        'If you would rather not wait, paying from Settings clears it immediately.' }
    ],
    action: { label: 'Pay now', href: baseUrl() + '/#settings' },
    footerNote: 'We try four times over a week before anything changes on your account.'
  }),

  payment_past_due: (c) => ({
    subject: 'Your Profitna account needs attention',
    heading: 'We have stopped trying that card',
    blocks: [
      { text: 'We tried the card on file for ' + c.organizationName + ' four times over the past ' +
        'week and it was declined each time. We have stopped trying rather than keep charging at it.' },
      { type: 'facts', rows: [
        ['Account', 'Past due'],
        ['Amount outstanding', c.amountLine],
        ['What the bank said', c.signals.lastChargeError || 'declined, with no reason given']
      ] },
      { text: 'Nothing has been deleted and nothing will be. Your books are intact and they come ' +
        'back as soon as a payment goes through — with a different card, or the same one once ' +
        'the bank is happy.' }
    ],
    action: { label: 'Sort it out', href: baseUrl() + '/#settings' }
  })
};

const KINDS = Object.keys(TEMPLATES);

// Render one, with its links. `context` carries the signals, the recipient and
// anything the step computed.
function render(kind, context) {
  const build = TEMPLATES[kind];
  if (!build) throw new Error('email: no template for "' + kind + '"');

  const spec = build(context);
  const links = {
    unsubscribeUrl: context.unsubscribeUrl || null,
    preferencesUrl: context.preferencesUrl || (baseUrl() + '/#settings'),
    category: context.category
  };
  const full = Object.assign({}, spec, links);

  return {
    subject: spec.subject,
    text: plain(full),
    html: wrap(full)
  };
}

// Everything the templates read, assembled once so a template cannot reach
// into the database and a test can hand it a plain object.
function context({ signals, user, category, data, unsubscribeUrl, preferencesUrl }) {
  const { amountFor } = require('../pricing');
  const amount = amountFor(signals.cycle, signals.seats);
  const daysLeft = Math.max(0, Math.ceil((signals.trialEnd.getTime() - Date.now()) / 86400000));
  const hoursLeft = Math.max(0, Math.round((signals.trialEnd.getTime() - Date.now()) / 3600000));

  return {
    signals,
    user,
    category,
    data: data || {},
    organizationName: signals.organizationName,
    daysLeft,
    hoursLeft,
    amountLine: money.format(Math.round(amount * 100)),
    planLine: money.format(Math.round(amount * 100)) + ' ' +
      (signals.cycle === 'annual' ? 'a year' : 'a month') +
      (signals.seats > 1 ? ' for ' + signals.seats + ' users' : ''),
    nextAttemptLine: 'in a day or two',
    unsubscribeUrl,
    preferencesUrl
  };
}

module.exports = { render, context, TEMPLATES, KINDS, baseUrl, wrap, plain, esc, theDate };
