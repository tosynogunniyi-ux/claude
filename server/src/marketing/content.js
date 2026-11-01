// What the public pages say.
//
// Content, not markup, kept apart from the layout so a claim can be checked
// without reading HTML.
//
// EVERY CLAIM HERE IS TRACEABLE TO CODE. The rule for this file: if a feature
// cannot be pointed at in the repository, it does not appear. Specifically
// absent, and deliberately:
//
//   AI. Ask Profitna exists (src/ai/ask.js) but returns nothing without
//   ANTHROPIC_API_KEY, which is not set in production — /api/health reports
//   askModel: null. Advertising it today would be selling something a new
//   customer would not find. It goes on these pages the day the key is set.
//
//   Online card payment of customer invoices. Built (src/payments/) and
//   hidden until CREDENTIALS_KEY is set.
//
//   Bank feeds. Mono's exchange and webhook exist; the connect widget is not
//   in the front end, so a customer cannot actually link an account.
//
//   Reviews, awards, certifications, partner logos, customer counts. None of
//   these are in evidence anywhere, so none are claimed.

const pricing = require('../pricing');
// The frozen, dated tax rule sets the payroll engine calculates with. The
// band figure on the homepage is drawn from these rather than typed again,
// so the picture cannot drift away from the payslips.
const statutory = require('../payroll/statutory');
const { esc, SUPPORT, COMPANY } = require('./render');
// The words live here; the pictures live next door.
const {
  icon, heroArt, chips, paye, steps, split, seatCalculator,
  invoiceArt, payslipArt, ledgerArt, ageingArt, fundsArt, dataArt, markArt, guides, priceArt
} = require('./figures');

const naira = (n) => '₦' + n.toLocaleString('en-NG');

const MONTHLY = pricing.PER_USER_MONTHLY;      // 5000
const ANNUAL = pricing.PER_USER_ANNUAL;        // 57000
const TRIAL = pricing.TRIAL_DAYS;              // 14
const MAX_SEATS = 25;                          // subscriptions CHECK, 001_init.sql

// Annual billed per seat vs twelve monthly payments.
const ANNUAL_SAVING = MONTHLY * 12 - ANNUAL;   // 3000

// ------------------------------------------------------------------ pieces

const hero = ({ eyebrow, h1, lede, primary = 'Start your free trial', secondary, art }) => `
<section class="hero${art ? ' split' : ''}"><div class="wrap">
  <div class="copy">
    ${eyebrow ? '<p class="eyebrow">' + esc(eyebrow) + '</p>' : ''}
    <h1>${h1}</h1>
    <p class="lede" style="margin-top:18px">${lede}</p>
    <div class="cta">
      <a class="btn primary" href="/app?start=1">${esc(primary)}</a>
      ${secondary ? '<a class="btn ghost" href="' + secondary[1] + '">' + esc(secondary[0]) + '</a>' : ''}
      <span class="note">${TRIAL} days free &middot; no card needed to start</span>
    </div>
  </div>
  ${art || ''}
</div></section>`;

const cards = (title, intro, items, band) => `
<section${band ? ' class="band"' : ''}><div class="wrap">
  <h2>${esc(title)}</h2>
  ${intro ? '<p class="lede" style="margin-bottom:28px">' + intro + '</p>' : ''}
  <div class="grid g3">
    ${items.map((it, i) => `<div class="card">
      ${it[2]
        ? '<span class="ico">' + icon(it[2]) + '</span>'
        : '<span class="num">' + String(i + 1).padStart(2, '0') + '</span>'}
      <h3>${esc(it[0])}</h3><p>${it[1]}</p></div>`).join('')}
  </div>
</div></section>`;

const prose = (title, paras, band) => `
<section${band ? ' class="band"' : ''}><div class="wrap narrow">
  <h2>${esc(title)}</h2>
  ${paras.map((p) => '<p>' + p + '</p>').join('')}
</div></section>`;

const faq = (items, band) => `
<section${band ? ' class="band"' : ''}><div class="wrap narrow">
  <h2>Questions</h2>
  <dl class="faq">
    ${items.map(([q, a]) => '<dt>' + esc(q) + '</dt><dd>' + a + '</dd>').join('')}
  </dl>
</div></section>`;

const closer = (line) => `
<section><div class="wrap narrow" style="text-align:center">
  <h2>${esc(line)}</h2>
  <p class="lede" style="margin:0 auto 6px">${TRIAL} days free. No card to start. Your books stay yours.</p>
  <div class="cta" style="justify-content:center">
    <a class="btn primary" href="/app?start=1">Start your free trial</a>
    <a class="btn ghost" href="/pricing">See pricing</a>
  </div>
</div></section>`;

// The questions, declared once.
//
// They are rendered on the page and repeated as structured data for the
// machines reading it, and those two must say the same thing — a FAQ marked
// up with answers a visitor cannot see is the kind of thing Google calls
// spam and removes a site's rich results for. One array, both uses.
const HOME_QUESTIONS = [
  ['What does it cost?',
    naira(MONTHLY) + ' per user per month, or ' + naira(ANNUAL) + ' per user per year. ' +
    '<a href="/pricing">Full pricing</a>.'],
  ['Do I need a card to start?',
    'No. The ' + TRIAL + '-day trial asks for nothing to pay with, and nothing is charged ' +
    'until you choose a plan.'],
  ['Can my accountant use it?',
    'Yes. Invite them as an accountant and they can keep the books without being able to ' +
    'change your subscription or approve payroll. <a href="/solutions/accountants">More</a>.'],
  ['Is it for churches too?',
    'Yes, with a different ledger: funds and giving rather than sales and VAT. ' +
    '<a href="/solutions/churches">More</a>.']
];

const PRICING_QUESTIONS = [
  ['Is there really no card at signup?',
    'No card. The ' + TRIAL + '-day trial asks for nothing to pay with. Payment is collected ' +
    'at the end of it, and only if you choose to continue.'],
  ['What is a user?',
    'One person with their own sign-in. A viewer who only reads reports still counts, because ' +
    'they still have an account.'],
  ['Can I change how many users I have?',
    'Yes. Seats can go up at any time, and down to the number of people actually using it.'],
  ['What happens when the trial ends?',
    'The books close until you activate a subscription. Nothing is deleted, and everything is ' +
    'there when you come back.'],
  ['Do churches pay the same?',
    'Yes. The church ledger is the same price as the business one.']
];

// ------------------------------------------------------------------- pages

const PAGES = [];
const add = (p) => { PAGES.push(p); return p; };

// ------------------------------------------------------------------- home
add({
  path: '/',
  name: 'Profitna',
  product: true,
  faqs: HOME_QUESTIONS,
  title: 'Profitna — Accounting and business finance for Nigerian businesses',
  description:
    'Invoicing, double-entry bookkeeping, Nigerian payroll with 2026 PAYE, and financial ' +
    'statements an accountant will accept. Built for Nigerian SMEs, churches and non-profits. ' +
    TRIAL + '-day free trial, no card needed.',
  changefreq: 'weekly',
  priority: '1.0',
  body:
    hero({
      eyebrow: 'For Nigerian businesses',
      h1: 'Know your numbers.<br>Grow your business.',
      lede: 'Profitna keeps a real set of books — double entry, naira to the kobo — while you ' +
        'get on with trading. Raise invoices, chase what you are owed, run payroll under the ' +
        'Nigeria Tax Act 2025, and hand your accountant statements that balance.',
      secondary: ['See what it does', '/features'],
      art: heroArt()
    }) +
    chips([
      ['ledger', 'Double entry, or nothing posts'],
      ['kobo', 'Figures in integer kobo'],
      ['calendar', 'Nigeria Tax Act 2025 PAYE'],
      ['export', 'Export your books any time']
    ]) +
    cards('What it actually does', null, [
      ['Invoices that chase themselves',
        'Raise an invoice, set it to repeat monthly, and Profitna issues it on the day it is due. ' +
        'Receipts, part payments, credit notes and an ageing list of who owes you what.',
        'invoice'],
      ['Books that balance',
        'Every invoice, bill and payment posts to a double-entry ledger. Trial balance, profit ' +
        'and loss, balance sheet and the general ledger behind every figure.',
        'ledger'],
      ['Nigerian payroll',
        'PAYE under the Nigeria Tax Act 2025, pension on basic, housing and transport, and NHF. ' +
        'Branded payslips and a bank payment schedule your bank will accept.',
        'payroll'],
      ['VAT and withholding tax',
        'Nigerian VAT at 7.5% and withholding tax on an invoice line, calculated in integer kobo ' +
        'so the figures never drift by a naira.',
        'percent'],
      ['Your team, with limits',
        'Admin, accountant and viewer. A viewer cannot change a figure; an accountant can keep ' +
        'the books but not approve a payroll.',
        'roles'],
      ['Two kinds of books',
        'A business ledger, or a church and non-profit ledger with funds, giving and no VAT. ' +
        'Chosen when you sign up.',
        'books']
    ], true) +
    steps('From a sale to a set of books', 'Three things happen. You do the first one.', [
      ['You raise the invoice',
        'Pick the customer, the items and the date. Set it to repeat if it repeats. Send it, ' +
        'or hand it over printed on A4 with your logo on it.',
        'invoice'],
      ['Profitna posts the entry',
        'Receivables debited, sales and VAT credited, in integer kobo. Nobody types a journal, ' +
        'and nothing posts unless both sides agree.',
        'ledger'],
      ['The statements follow',
        'Trial balance, profit and loss, balance sheet and the general ledger behind every ' +
        'figure — built from the entries, not kept alongside them.',
        'books']
    ], true) +
    split({
      eyebrow: 'Getting paid',
      title: 'See what you are owed, and how long you have been owed it',
      paras: [
        'Every unpaid invoice has an age, and the older it gets the less likely it is to be ' +
        'paid at all. Profitna keeps the ageing list in front of you rather than inside a ' +
        'report nobody opens.',
        'A customer paying half is half paid. The balance stays visible until the last kobo ' +
        'of it is cleared, and the receipt says which invoices it went against.'
      ],
      art: ageingArt()
    }) +
    split({
      eyebrow: 'Payroll',
      title: 'Payslips your staff will understand, figures your auditor will accept',
      paras: [
        'PAYE under the Nigeria Tax Act 2025, pension on basic, housing and transport rather ' +
        'than on gross, and NHF on basic. Approve the run and it posts to the ledger; correct ' +
        'it and the correction is a reversal, not a quiet edit.',
        'The bank schedule comes out as CSV, Excel or a signed PDF, in the shape a Nigerian ' +
        'bank expects to be given.'
      ],
      art: payslipArt(),
      flip: true,
      band: true
    }) +
    paye('The 2026 PAYE bands, the way Profitna applies them',
      'The Nigeria Tax Act 2025 abolished the Consolidated Relief Allowance and rewrote every ' +
      'band from 1 January 2026. This is the table Profitna calculates from — read straight out ' +
      'of the payroll engine, not typed onto a marketing page.',
      'Bands apply to annual chargeable income and are spread across the year, so a bonus is ' +
      'taxed in the month it is paid and a mid-year joiner still gets the whole nil band. ' +
      'Rent relief is 20% of rent actually paid, capped at ' + naira(500000) + ' and only where ' +
      'the employee declares it. A salary at or below ' + naira(70000) + ' a month is exempt. ' +
      '<a href="/features">How payroll works</a>.') +
    prose('Built for how Nigerian businesses actually trade', [
      'Most accounting software is written somewhere else and translated. Profitna was not. ' +
      'Money is held in integer kobo rather than decimals, because an invoice that disagrees ' +
      'with itself by a kobo is an invoice a customer will not pay.',
      'The tax rules are stored by the date they took effect, so re-opening March next year ' +
      'still calculates March under March’s law — and a 2025 correction still gets 2025’s ' +
      'answer, Consolidated Relief Allowance and all.',
      'Payslips, invoices and statements carry your logo and print on A4. The naira sign renders ' +
      'properly, which sounds like a small thing until you have been sent a PDF where it does not.'
    ], true) +
    faq(HOME_QUESTIONS) +
    closer('Start keeping books you can trust')
});

// --------------------------------------------------------------- features
add({
  path: '/features',
  name: 'Features',
  product: true,
  title: 'Features — invoicing, bookkeeping, payroll and reports | Profitna',
  description:
    'Everything Profitna does today: recurring invoices, receipts and credit notes, a ' +
    'double-entry ledger, Nigerian PAYE and pension payroll, A4 payslips and bank schedules, ' +
    'and financial statements that balance.',
  changefreq: 'monthly',
  priority: '0.9',
  body:
    hero({
      eyebrow: 'Features',
      h1: 'What Profitna does',
      lede: 'Everything on this page is in the product today. Anything still being built is not ' +
        'listed here, and anything that needs setting up says so.',
      secondary: ['Pricing', '/pricing']
    }) +
    split({
      eyebrow: 'What a customer receives',
      title: 'An invoice that looks like a company sent it',
      paras: [
        'Five A4 designs, your logo and your details, numbering that restarts cleanly each ' +
        'year and cannot collide. VAT and withholding tax sit on their own lines, in integer ' +
        'kobo, because they are somebody else\u2019s money passing through your hands.',
        'Set one to repeat and it raises itself on the day it is due, until you stop it.'
      ],
      art: invoiceArt()
    }) +
    cards('Invoicing and getting paid', null, [
      ['Invoices', 'Five A4 designs, your logo, your details. Numbering that restarts cleanly each year and cannot collide.'],
      ['Recurring invoices', 'A schedule raises the invoice on the day it is due — monthly, weekly, or every N months — and stops when you tell it to.'],
      ['Receipts and part payments', 'One payment across several invoices. What is left shows as outstanding, not as paid.'],
      ['Credit notes', 'Issue against an invoice or on its own, and apply it to what the customer owes.'],
      ['Receivables ageing', 'Who owes you, how long it has been, and the total you are carrying.'],
      ['VAT and withholding tax', 'Nigerian VAT at 7.5% and WHT per line, in integer kobo.']
    ], true) +
    split({
      eyebrow: 'Underneath',
      title: 'A real ledger, not a spreadsheet in a browser',
      paras: [
        'That invoice posted two sides of an entry the moment it was issued. Debits equal ' +
        'credits or the entry is refused — there is no state in which the books are a little ' +
        'bit out and somebody will look at it later.',
        'Corrections are reversals. Close a month and nothing can post into it afterwards.'
      ],
      art: ledgerArt(),
      flip: true,
      band: true
    }) +
    cards('The books underneath', 'Nothing is a spreadsheet pretending to be a ledger. Every document posts a balanced journal entry.', [
      ['Double-entry ledger', 'Debits equal credits or the entry is refused. Entries are reversed, never edited.'],
      ['Trial balance', 'Every account with its balance, from the journals themselves.'],
      ['Profit and loss', 'Income and expenses over any window, broken down by the categories on your own chart.'],
      ['Balance sheet', 'Assets, liabilities and equity as at a date.'],
      ['General ledger', 'Every posting to any account, with the document that caused it.'],
      ['Period lock', 'Close a month and nothing can post into it afterwards.']
    ]) +
    split({
      eyebrow: 'Payroll',
      title: 'One run, three places it has to be right',
      paras: [
        'The payslip the employee reads, the schedule the bank is given, and the entry the ' +
        'ledger keeps. Profitna produces all three from the same approved run, so they cannot ' +
        'disagree with each other.',
        'PAYE is worked annually and spread across the year, which is why a bonus is taxed in ' +
        'the month it is paid and a mid-year joiner still gets the whole nil band.'
      ],
      art: payslipArt()
    }) +
    cards('Payroll', 'Nigerian payroll under the Nigeria Tax Act 2025, in force since 1 January 2026.', [
      ['PAYE, correctly', 'Annual bands applied annually and spread across the year, so a bonus is taxed in the month it is paid and a mid-year joiner gets the whole nil band.'],
      ['Pension and NHF', 'Employee and employer pension on basic, housing and transport — not on gross, which is the commonest error — and NHF on basic.'],
      ['Branded payslips', 'A4 PDFs with your logo, singly or for everyone at once.'],
      ['Bank payment schedule', 'Name, bank, account number and net pay, as CSV, Excel or a signed PDF.'],
      ['Approval that sticks', 'An approved payroll posts to the ledger and can only be reversed, never quietly edited.'],
      ['Remittance tracking', 'What you owe in PAYE, pension and NHF, and what you have actually paid.']
    ], true) +
    cards('Everything else', null, [
      ['Bills and expenses', 'What you owe, when it falls due, and what it cost you.'],
      ['Products and stock', 'Items, cost, quantity and value on hand.'],
      ['Bank reconciliation', 'Import a statement and match it against your books.'],
      ['Customers and suppliers', 'Contacts, what they are worth to you, and what is outstanding.'],
      ['Roles', 'Admin, accountant, viewer — enforced by the server, not just hidden in the interface.'],
      ['Your data, exportable', 'Your books are yours. Export them whenever you like.']
    ]) +
    closer('See it with your own numbers')
});

// ---------------------------------------------------------------- pricing
add({
  path: '/pricing',
  name: 'Pricing',
  product: true,
  faqs: PRICING_QUESTIONS,
  title: 'Pricing — ' + naira(MONTHLY) + ' per user per month | Profitna',
  description:
    'Profitna costs ' + naira(MONTHLY) + ' per user per month or ' + naira(ANNUAL) + ' per user ' +
    'per year. Every feature on every plan. ' + TRIAL + '-day free trial, no card required.',
  changefreq: 'monthly',
  priority: '0.9',
  body:
    hero({
      eyebrow: 'Pricing',
      h1: 'One price. Every feature.',
      lede: 'There is no cheaper tier that leaves out the thing you need. You pay for the people ' +
        'who use it, and everyone gets all of it.',
      secondary: ['What you get', '/features']
    }) +
    `<section class="band"><div class="wrap"><div class="grid g2">
      <div class="card">
        <p class="eyebrow" style="margin-bottom:6px">Monthly</p>
        <div class="price"><span class="amt">${naira(MONTHLY)}</span><span class="per">per user, per month</span></div>
        <p class="note">Billed monthly. Change or cancel whenever you like.</p>
        <a class="btn primary" href="/app?start=1" style="margin-top:10px">Start free</a>
      </div>
      <div class="card" style="border-color:var(--gold)">
        <p class="eyebrow" style="margin-bottom:6px">Yearly &middot; save ${naira(ANNUAL_SAVING)} a seat</p>
        <div class="price"><span class="amt">${naira(ANNUAL)}</span><span class="per">per user, per year</span></div>
        <p class="note">${naira(Math.round(ANNUAL / 12))} a month, paid once a year.</p>
        <a class="btn primary" href="/app?start=1" style="margin-top:10px">Start free</a>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <h3>Included on both, for everyone</h3>
      <ul class="tick">
        <li>Invoicing, recurring invoices, receipts and credit notes</li>
        <li>Double-entry ledger, trial balance, profit and loss, balance sheet</li>
        <li>Nigerian payroll: PAYE, pension, NHF, payslips and bank schedules</li>
        <li>VAT and withholding tax</li>
        <li>Bills, expenses, products, bank reconciliation</li>
        <li>Up to ${MAX_SEATS} users on one set of books</li>
        <li>Your own branding on invoices and payslips</li>
      </ul>
    </div></div></section>` +
    split({
      eyebrow: 'Monthly or yearly',
      title: 'Pay as you go, or keep a month',
      paras: [
        'The yearly price is twelve months with one taken off, per person. Nothing else ' +
        'changes: the same features, the same ' + MAX_SEATS + '-person ceiling, the same books.',
        'Start on whichever you like. Moving from monthly to yearly later does not cost you ' +
        'the time you have already paid for.'
      ],
      art: priceArt()
    }) +
    seatCalculator(MAX_SEATS) +
    faq(PRICING_QUESTIONS, true) +
    closer('Try it for ' + TRIAL + ' days')
});

// ----------------------------------------------------------- solutions x3
add({
  path: '/solutions/retail',
  title: 'Accounting software for Nigerian retailers and traders | Profitna',
  description:
    'For shops, distributors and traders: invoice customers, track stock and cost, see what ' +
    'you are owed, and keep books that balance. ' + TRIAL + '-day free trial.',
  changefreq: 'monthly',
  priority: '0.8',
  body:
    hero({
      eyebrow: 'Retail and trading',
      h1: 'Stock in, invoices out,<br>books that keep themselves',
      lede: 'If you buy to sell, your money is tied up in two places: stock on the shelf and ' +
        'invoices nobody has paid. Profitna shows you both, and posts the accounting behind ' +
        'them without you thinking about debits.'
    }) +
    cards('Where the money goes', null, [
      ['What is on the shelf', 'Items, what each cost you, how many you hold and what that is worth today.'],
      ['What you are owed', 'An ageing list: who owes you, how much, and how long it has been sitting there.'],
      ['Part payments', 'A customer paying half is half paid, not paid. The balance stays visible until it is cleared.'],
      ['Repeat customers', 'A standing monthly invoice raises itself on the day it is due.'],
      ['VAT', 'Nigerian VAT at 7.5%, on the line, in kobo.'],
      ['Your margin', 'Profit and loss over any window, broken down the way your own categories are.']
    ], true) +
    split({
      eyebrow: 'The money you cannot see',
      title: 'Half your cash is on a shelf, the other half is on somebody else\u2019s desk',
      paras: [
        'Stock you have paid for and invoices nobody has settled are both your money, and ' +
        'neither is in your bank account. Profitna shows you what each is worth today.',
        'The ageing list is the one to watch: an invoice past ninety days is a different ' +
        'kind of problem from one raised last week.'
      ],
      art: ageingArt(),
      band: true
    }) +
    prose('Why the ledger matters to a trader', [
      'Plenty of shops run on a notebook and a bank app, and it works until somebody asks a ' +
      'question the notebook cannot answer — a bank wanting statements, a partner wanting to ' +
      'know what the business is worth, a tax office wanting a return.',
      'Profitna keeps the proper books in the background. You raise invoices and record what you ' +
      'buy; the double-entry happens underneath, and when the question comes you have a trial ' +
      'balance rather than a shoebox.'
    ]) +
    closer('See what your shop is actually worth')
});

add({
  path: '/solutions/accountants',
  title: 'Accounting software for Nigerian accountants | Profitna',
  description:
    'Keep client books in a real double-entry ledger with a trial balance, period locks and ' +
    'reversals rather than edits. Role-based access so clients see their figures without ' +
    'changing your postings.',
  changefreq: 'monthly',
  priority: '0.8',
  body:
    hero({
      eyebrow: 'Accountants and bookkeepers',
      h1: 'A real ledger,<br>not a spreadsheet in a browser',
      lede: 'Debits equal credits or the entry is refused. Corrections are reversals, not edits. ' +
        'Closed periods stay closed. The things you would check first are the things this was ' +
        'built around.'
    }) +
    cards('What you will want to know first', null, [
      ['It balances, by construction', 'An unbalanced journal is rejected rather than saved and reported later.'],
      ['Reversals, never edits', 'A correction writes a mirror entry on the date it was made. Both stay visible, and January stays as filed.'],
      ['Period lock', 'Close through a date and nothing posts before it — including an automated payroll or recurring invoice.'],
      ['Audit trail', 'Who changed what, and when. Not optional, not clearable.'],
      ['Every figure traces back', 'From the trial balance to the ledger to the invoice that caused it.'],
      ['Roles that hold', 'A viewer cannot post. An accountant can keep the books but cannot approve payroll or change the subscription.']
    ], true) +
    split({
      eyebrow: 'What your client sees',
      title: 'A ledger you can hand over without handing over control',
      paras: [
        'Invite the client as an admin on their own books and yourself as the accountant. ' +
        'They raise their invoices; you keep the ledger. Neither of you can quietly undo the ' +
        'other, because a correction is a reversal and it is signed.',
        'Debits equal credits or the entry is refused, so the trial balance you are handed at ' +
        'year end is a trial balance rather than a starting point.'
      ],
      art: ledgerArt(),
      flip: true,
      band: true
    }) +
    prose('Working with your client', [
      'Each business is its own set of books, with its own users. You are invited to the ones you ' +
      'keep, with the accountant role, and your client keeps admin of their own account — so ' +
      'nobody is sharing a password.',
      'Statements come out as PDFs on your client’s letterhead. Payroll is run and approved ' +
      'by them while the accounting posts automatically, which removes the monthly journal you ' +
      'would otherwise be writing by hand.'
    ]) +
    closer('Put a client on it this month')
});

add({
  path: '/solutions/churches',
  title: 'Church and non-profit accounting software in Nigeria | Profitna',
  description:
    'Fund accounting for Nigerian churches and non-profits: giving, funds, and statements ' +
    'trustees can read. No VAT, no sales ledger — a different set of books, not a business ' +
    'one relabelled.',
  changefreq: 'monthly',
  priority: '0.8',
  body:
    hero({
      eyebrow: 'Churches and non-profits',
      h1: 'Books your trustees<br>can actually read',
      lede: 'Choose the church ledger when you sign up and the whole product changes: giving ' +
        'rather than sales, funds rather than VAT, members rather than customers. It is a ' +
        'different set of books, not a business one with the words swapped.'
    }) +
    cards('How it differs', null, [
      ['Giving, not revenue', 'Tithes, offerings, pledges and project giving, recorded as what they are.'],
      ['Funds', 'Money given for a building is not money available for salaries, and the books say so.'],
      ['No VAT', 'The church ledger is set up without it, rather than asking you to ignore a field.'],
      ['Members and vendors', 'The contact list is named for who is actually in it.'],
      ['Pastoral payroll', 'The same Nigerian PAYE and pension, for staff on the payroll.'],
      ['Statements for a board', 'Income and expenditure that a trustee or an auditor can follow.']
    ], true) +
    split({
      eyebrow: 'Funds',
      title: 'Designated giving that stays designated',
      paras: [
        'A building fund is not general income with a label on it. Profitna keeps each fund ' +
        'as its own balance, so a gift given for one thing cannot quietly pay for another, ' +
        'and the trustees can see at a glance what is left in each.',
        'The ledger underneath is the same double-entry ledger a business gets, without VAT ' +
        'and sales where giving and funds belong.'
      ],
      art: fundsArt(),
      band: true
    }) +
    prose('Accountability without a finance department', [
      'Most churches and non-profits are run by people who did not come to do bookkeeping, and ' +
      'who are nonetheless accountable for other people’s money.',
      'Profitna’s church ledger is the ordinary double-entry one with the right words on it ' +
      'and the right things in it, so a monthly statement to the board is something you print ' +
      'rather than something you spend a weekend assembling.'
    ]) +
    closer('Keep accounts the board can follow')
});

// ------------------------------------------------------------------ about
add({
  path: '/about',
  title: 'About Profitna and ' + COMPANY,
  description:
    'Profitna is accounting and business finance software for Nigerian businesses, churches ' +
    'and non-profits, operated by ' + COMPANY + ', registered in Nigeria.',
  changefreq: 'monthly',
  priority: '0.7',
  body:
    hero({
      eyebrow: 'About',
      h1: 'Who makes Profitna',
      lede: 'Profitna is operated by ' + COMPANY + ', a company registered in Nigeria. ' +
        'It is built for Nigerian businesses, churches and non-profits.',
      secondary: ['Contact us', '/contact']
    }) +
    prose('What we are trying to do', [
      'Most Nigerian small businesses keep their accounts in a notebook, a WhatsApp thread and a ' +
      'bank app, and they manage — until a bank, a partner or a tax office asks a question ' +
      'none of those can answer.',
      'The software that does answer those questions is mostly written for somewhere else. It ' +
      'assumes different tax, different banking, different paperwork, and it tends to arrive ' +
      'priced in dollars.',
      'Profitna is an attempt at the other thing: a proper double-entry accounting system built ' +
      'around how Nigerian businesses actually trade, at a price a Nigerian small business can ' +
      'pay, that an accountant will still take seriously.'
    ]) +
    split({
      eyebrow: 'The name',
      title: 'Know your numbers, grow your business',
      paras: [
        'It is not a slogan we arrived at afterwards. The whole product is the first half of ' +
        'that sentence: a business that can see its own figures makes different decisions ' +
        'from one that cannot.',
        'Profitna is operated by <strong>' + COMPANY + '</strong>, registered in Nigeria, and ' +
        'runs at profitna.com.'
      ],
      art: markArt()
    }) +
    prose('How it is built', [
      'Money is integer kobo throughout. Nothing multiplies a decimal by a hundred and hopes.',
      'Tax rules are stored by the date they took effect, so a payroll re-opened next year is ' +
      'still calculated under the law of the month it covers.',
      'Corrections are reversals rather than edits, and closed periods stay closed — because ' +
      'books you can quietly change are books nobody can rely on.',
      'Where something is not finished, the product says so rather than pretending. Where a ' +
      'figure rests on a reading of the law that is not yet settled, the screen says that too.'
    ], true) +
    prose('The company', [
      '<strong>' + COMPANY + '</strong> is registered in Nigeria and operates Profitna at ' +
      'profitna.com. Written questions reach a person at <a href="mailto:' + SUPPORT + '">' +
      SUPPORT + '</a>.',
      'How we handle your data, who else receives it and how long it is kept is set out in the ' +
      '<a href="/privacy">privacy notice</a>.'
    ]) +
    closer('Try it on your own books')
});

// --------------------------------------------------------------- security
add({
  path: '/security',
  title: 'Security and data protection | Profitna',
  description:
    'How Profitna protects your books: separation between businesses, bcrypt password hashing, ' +
    'two-factor administrative access, verified nightly backups and NDPA-aligned data handling.',
  changefreq: 'monthly',
  priority: '0.7',
  body:
    hero({
      eyebrow: 'Security',
      h1: 'How your books are protected',
      lede: 'This is a plain description of what is actually in place. Where something is not ' +
        'done yet, it is not claimed here.',
      secondary: ['Privacy notice', '/privacy']
    }) +
    cards('In place today', null, [
      ['Separation between businesses', 'Every query carries the organisation it belongs to. One business cannot read another’s books, and that is tested rather than assumed.'],
      ['Passwords', 'Stored as bcrypt hashes. Nobody at Profitna can read your password, and neither could anyone who stole the database.'],
      ['Transport', 'Everything travels over HTTPS.'],
      ['Administrative access', 'The owner’s console needs a second factor, and is hidden from anyone it does not recognise.'],
      ['Backups', 'Taken on a schedule and verified by being read back, not merely written.'],
      ['Card details', 'Your card number and CVV never reach Profitna. They go from your browser to the payment processor.']
    ], true) +
    prose('Your data, and the law', [
      'Under the Nigeria Data Protection Act 2023 you can ask for a copy of what we hold, have it ' +
      'corrected, or have it deleted where we are not required to keep it. The ' +
      '<a href="/privacy">privacy notice</a> sets out each right and how to use it.',
      'There is a point in it worth repeating here: when you record a customer, supplier or ' +
      'employee in Profitna, that is <em>their</em> personal data and <strong>you</strong> are ' +
      'the controller of it. We process it to run the service for you, and for nothing else — ' +
      'not to advertise, not to train anything, not to build a profile of anyone.'
    ]) +
    split({
      eyebrow: 'Where it is',
      title: 'Your books sit in one place, and you can see which',
      paras: [
        'The service runs on servers in the United Kingdom. Nothing about your books is ' +
        'stored in the browser beyond the session that signs you in, and everything between ' +
        'you and the server travels over HTTPS.',
        'A backup is taken every night and fourteen are kept, so a bad day is a restore ' +
        'rather than a closure. <a href="/privacy">The privacy notice</a> names every company ' +
        'that touches any of it, and what they get.'
      ],
      art: dataArt(),
      flip: true,
      band: true
    }) +
    prose('Being straight about limits', [
      'No system is perfect, and a security page that claims otherwise is telling you something ' +
      'about the people who wrote it.',
      'If we discover a breach likely to harm you, we will tell you and the Nigeria Data ' +
      'Protection Commission, as the Act requires. If you think you have found a problem, write ' +
      'to <a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a> and a person will read it.'
    ], true) +
    closer('Books you can rely on')
});

// -------------------------------------------------------------- resources
add({
  path: '/resources',
  title: 'Guides to Nigerian business accounting, tax and payroll | Profitna',
  description:
    'Plain explanations of the things Nigerian small businesses have to get right: PAYE under ' +
    'the Nigeria Tax Act 2025, VAT and withholding tax, pension and NHF, and what a set of ' +
    'books is actually for.',
  changefreq: 'weekly',
  priority: '0.7',
  body:
    hero({
      eyebrow: 'Resources',
      h1: 'The things nobody explained',
      lede: 'Short, practical explanations of the rules a Nigerian business has to follow, ' +
        'written so that somebody who did not study accounting can act on them.'
    }) +
    guides('Starting points', 'Each of these is a question we have been asked more than once.', [
      ['What changed in PAYE for 2026',
        'The Nigeria Tax Act 2025 took effect on 1 January 2026. The Consolidated Relief ' +
        'Allowance is gone, there are new bands, and the first ₦800,000 of chargeable ' +
        'income is taxed at nothing.', 'bands'],
      ['Why pension is not 8% of gross',
        'Pension is contributed on basic, housing and transport — not on gross pay. Getting ' +
        'this wrong is the commonest payroll error in Nigeria, and it goes unnoticed for years.', 'split'],
      ['VAT and withholding tax, together',
        'They are different taxes doing different jobs, and an invoice often carries both. What ' +
        'each one is, who holds the money, and who remits it.', 'twotax'],
      ['What a trial balance is for',
        'Not an accounting ritual. It is the check that says your books add up, and the first ' +
        'thing anyone lending you money will ask to see.', 'balance'],
      ['Invoice numbering that will not embarrass you',
        'Why numbers must not repeat, must not have gaps you cannot explain, and what happens ' +
        'at the turn of the year.', 'numbers'],
      ['When a sale becomes revenue',
        'Money arriving and revenue being earned are two different events, often in different ' +
        'months, and treating them as one is how a profitable month turns out not to be.', 'timing']
    ], true) +
    paye('PAYE in 2026, at a glance',
      'The table the first of those guides is about. It is read out of the payroll engine, so ' +
      'it is the same table your payslips are calculated from.',
      'Rent relief is 20% of rent actually paid, capped at ' + naira(500000) + ', and only ' +
      'where the employee declares it. A salary at or below ' + naira(70000) + ' a month is ' +
      'exempt. <a href="/features">What payroll does</a>.',
      true) +
    prose('More coming', [
      'This section is being written. If there is something you want explained, say so at ' +
      '<a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a> and it will go near the front of the ' +
      'queue.'
    ]) +
    closer('Put the theory to work')
});

// ---------------------------------------------------------------- contact
add({
  path: '/contact',
  title: 'Contact Profitna',
  description:
    'Reach Profitna at ' + SUPPORT + '. Questions about the product, your account, billing, ' +
    'or data protection all go to a person.',
  changefreq: 'yearly',
  priority: '0.6',
  body:
    hero({
      eyebrow: 'Contact',
      h1: 'Talk to a person',
      lede: 'One address, read by someone who can do something about it.',
      primary: 'Start your free trial',
      secondary: ['Email ' + SUPPORT, 'mailto:' + SUPPORT]
    }) +
    cards('What to write about', null, [
      ['Support',
        'Something wrong, something confusing, or a figure you cannot explain.<br>' +
        '<a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a>',
        'mail'],
      ['Billing and accounts',
        'Plans, seats, invoices and anything about what you are paying.<br>' +
        '<a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a>',
        'invoice'],
      ['Data protection',
        'A copy of your data, a correction, or a deletion. See the ' +
        '<a href="/privacy">privacy notice</a>.<br>' +
        '<a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a>',
        'shield']
    ], true) +
    prose('If you are already a customer', [
      'Sign in and open <strong>Settings → Help and support</strong>. The message it starts ' +
      'already carries your account reference, which saves the two emails it otherwise takes to ' +
      'work out which books you mean.'
    ]) +
    split({
      eyebrow: 'Who you are writing to',
      title: 'A company, with a name and a country',
      paras: [
        'Profitna is operated by <strong>' + COMPANY + '</strong>, registered in Nigeria. ' +
        'The service runs on servers in the United Kingdom, and the ' +
        '<a href="/privacy">privacy notice</a> names everyone else who touches any of it.',
        '<a href="/about">More about the company</a>.'
      ],
      art: markArt()
    })
});

const BY_PATH = new Map(PAGES.map((p) => [p.path, p]));

module.exports = { PAGES, BY_PATH, MONTHLY, ANNUAL, TRIAL, MAX_SEATS, naira };
