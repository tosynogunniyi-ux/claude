# Where Profitna stands

A plain-language record of what has been built, what is live, and what is
still waiting on somebody. Kept in the repository so it is always reachable:
**github.com/tosynogunniyi-ux/claude → `docs/STATUS.md`**.

Last updated 15 October 2026. **Monnify is live and the first real payment
has gone through. Smart Invoicing now has a general ledger, server-side PDFs,
an invoice builder, payments, receipts, credit notes, receivables — and
invoices that raise themselves.**

---

## What Profitna is

Accounting and business finance for Nigerian businesses — SMEs, companies,
churches and non-profits. Invoicing, bills, a cash ledger, inventory, bank
reconciliation, and financial reports on a cash basis in ₦, with VAT and
deductibility handled the way Nigerian tax rules expect.

Two sets of books, chosen at signup: **SME / business / company**, and
**church / non-profit**, which swaps invoices for pledges and adds fund
accounting.

| Layer | What it is |
|---|---|
| Front end | One HTML page rendered through React, no build step |
| Back end | Node.js + Express |
| Database | PostgreSQL |
| Hosting | Docker on a Hostinger VPS, managed by Easypanel |
| Live at | profitna.com |
| Code | github.com/tosynogunniyi-ux/claude, branch **`main`** |

---

## What was built, in order

**The Control Center** — the owner's console at `/admin`. Every registered
account, what each pays, when it renews, what has happened on it, and the
controls to suspend, deactivate or reinstate. It is a separate application
behind separate credentials: its own table, its own cookie, its own sessions
and a required second factor. A customer's `admin` role is admin of one set of
books and can never reach it. There is no route that creates an owner account
— only the command line — and until one exists `/admin` answers 404 rather
than advertising itself.

**Automatic billing** — a scheduler inside the server that ends trials and
renews terms. It takes a Postgres advisory lock each pass, so running more
than one container never charges the same card twice. A declined card is
retried after 1, 3, 5 and 7 days, then left past due rather than cancelled.

**The card-free trial** — signing up asks for no card of any kind. When the
trial ends the books close behind a payment screen and **nothing is deleted**.
The organisation, the ledger, the invoices and every figure stay exactly where
they were and come back the moment payment goes through.

**Roles and the team** — admin, accountant, viewer. Enforced by the API and
shown in the interface: what a role cannot do is greyed out *and* disabled, so
the keyboard cannot reach it either. Every figure stays readable; it is the
controls that go quiet. Inviting somebody produces a link to copy and send,
because there is no email delivery in this product and none is pretended.

**Settings** — bank accounts with opening balances, the company logo on every
report, a "Powered by Profitna" footer, and a single Save button that governs
the lot, with a warning before leaving with unsaved changes.

**The visual pass** — a composed light field behind the sign-in screen (drawn
in CSS and SVG, not a photograph, so it is sharp at any size and costs nothing
on a metered connection), layered card shadows, motion that yields to
`prefers-reduced-motion`, and a branded loading screen instead of a blank
page. A real defect was fixed on the way: on a phone the dark panel was stuck
at 300px with a strip of bare cream beside it and the headline broken over
seven lines.

**Monnify** — now the payment processor, alongside Paystack. Both sit behind
one gateway module, so the routes, the scheduler and the paywall never learn
which is in use. `PAYMENT_PROVIDER` settles the choice.

**Subscribe before the trial ends** — a button in Settings for anyone who does
not want to wait. Paying early does not cost the remaining days: the paid term
starts when the trial *would* have ended, which is what the banner had always
promised.

**Ask Profitna** — the question box now has a model behind it. It is sent a
snapshot of the books with every question (twelve months of totals, who owes
what, cash, stock — about 1,300 tokens whether the books hold 100 entries or
8,000), and it can run five read-only lookups for anything the snapshot does
not hold. The table under each answer is built from the rows the lookup
returned, not from the model's reply, so a figure on screen is always one the
database produced. Without an API key nothing is faked: the pill says
"Simulated · no model connected" and the screen answers the six questions it
can work out for itself.

**Meta ads tracking** — a pixel in the browser and the Conversions API on the
server, reporting the same events under the same ids so Meta counts each one
once. The sale is reported from the server, after the processor has confirmed
the payment, so it cannot be blocked by an ad blocker or faked by a browser.
Email and name are SHA-256 hashed before they leave; nothing about a
customer's books is ever sent. Unset `META_PIXEL_ID` and none of it runs.

**Smart Invoicing** — built over four passes and still going:

- *The foundation.* Money is counted in integer kobo everywhere, VAT and
  withholding tax follow Nigerian rules (withholding is **not** a discount —
  the invoice is owed in full and a separate figure says what lands in the
  bank), and numbers are allocated by a row lock so two invoices created in
  the same second cannot collide.
- *PDFs.* Server-side A4 invoices in five designs, branded, printable and
  downloadable, with the naira sign rendering as ₦ rather than a broken bar.
- *The general ledger.* Real double entry, on an accrual basis. Every invoice,
  bill, payment and cash entry already in the product was posted into it —
  13,807 entries across 138 organisations, none unbalanced, every balance
  sheet balancing and every receivable reconciling.
- *The builder and the dashboard.* Writing an invoice line by line, with the
  totals the server will charge rather than the browser's own arithmetic.
- *Payments and receivables.* One payment can settle several invoices, and
  whatever is left over sits on the customer's account as a liability rather
  than being forced onto an invoice. Credit notes correct an invoice that has
  already been sent. And customers can pay online — into the business's own
  Paystack or Monnify account.
- *Recurring invoices.* A retainer set up once raises itself on the day,
  numbered, posted to the books and VAT worked out from the settings as they
  stand that month. Pause it, skip a cycle, stop it — and a schedule that
  cannot raise its invoice stops visibly with the reason on it rather than
  failing once an hour into a log nobody reads. A customer can never be
  billed twice for the same month: the database will not allow it.

**Your money goes to you.** The payment account a business connects is its
own. Profitna records the payment and settles the invoice; it never holds the
money and it is never an intermediary. The keys that collect Profitna's own
subscription fees and the keys that collect a customer's invoice payment are
different keys in different places, and no code path can confuse them.

**Automatic email** — the lifecycle: a welcome, setup help if nothing has been
recorded after a day, an offer of help on day 3, guidance six days after they
actually start using it, where the trial stands on day 10, a reminder 48 hours
before the real expiry date, the account status at expiry, and a paid
onboarding once money has been confirmed. Plus a note for each failed charge.

Every one of them is conditional. Nothing is queued in advance: the pass asks
what is true *now*, so somebody who activates on day 2 never gets the day-3
message and somebody who pays on day 9 never gets the expiry reminder — not
because anything cancelled them, but because they never qualify.

Three classes of message, kept apart: account messages (which cannot be
switched off, and the preferences page says why), getting-started help (one
click to stop), and marketing (off until somebody deliberately turns it on —
and nothing in the lifecycle is in that class). A bounce or a spam complaint
suppresses the address for everything, permanently, because that belongs to
the mailbox rather than to the account.

**It does not send yet.** See "Still open" — it needs a mail provider and a
sending domain, and until then every message is decided, written down and
held so you can read exactly what would have gone out.

**Trial length, per account** — the default is 14 days for new sign-ups. It
went 14 → 30 → 14, and the second change could not work like the first: the
length is now recorded on each subscription when it is created, so lowering
the default reaches the next sign-up and leaves running trials exactly as
promised. Lengthening and shortening are not symmetrical; only one is safe to
apply retroactively.

---

## Three things worth knowing about how this is built

**Derived, not stored.** Document status, subscription expiry, bank balances,
whether an account is locked, when a trial ends — all worked out from the
dates when read. A stored flag is only correct until the next midnight nothing
ran through. This is why the trial could go from 14 days to 30 for existing
users without touching a single row.

**Monnify counts in naira, Paystack counts in kobo.** Nothing multiplies by
100 on the Monnify path, and a stray one would charge a customer a hundred
times over. The tests assert the figure that actually goes over the wire.

**Card numbers never reach the server.** On every path. The card is typed into
the processor's own window; what comes back is a reference the server verifies
before trusting a naira of it. A test asserts nothing resembling a card number
appears in a charge.

---

## Monnify, live

Live since 9 October 2026, confirmed by a real ₦5,000 payment that activated
the account. Getting there took five wrong turns worth remembering, because
each hid the next:

1. The app had no timeout on calls to Monnify, so a slow one hung until the
   proxy served its own page.
2. The browser was shown a raw JSON parser error instead of a sentence.
3. The database pool had no timeouts either — not the cause here, but the
   same class of fault.
4. **Failures were answered with HTTP 502, and the proxy replaces a 5xx body
   with its own HTML.** Every careful message about Monnify was being thrown
   away at the last hop. Answering 424 fixed it, and only then was the real
   error visible.
5. **The server opened a Monnify transaction and then handed the SDK the same
   reference**, so the SDK's own attempt was a duplicate. Monnify reported
   "unable to process your transaction request" from inside its window.

The lesson worth keeping from (4): a failure you are deliberately reporting to
somebody belongs in the 4xx range. 5xx is the proxy's to take.

## Switching Monnify to live

Monnify's sandbox and live dashboards are **separate accounts with separate
keys and separate contract codes**. All four values change together, in
Easypanel → your app service → Environment:

    MONNIFY_ENV=live
    MONNIFY_API_KEY=<live key>
    MONNIFY_SECRET_KEY=<live secret>
    MONNIFY_CONTRACT_CODE=<live contract code>

Then:

1. **Unset `MONNIFY_BASE_URL`** if it was ever set — it overrides `MONNIFY_ENV`
   completely and would silently send live traffic somewhere else.
2. **Register the webhook in the live dashboard**:
   `https://profitna.com/api/webhooks/monnify`. Sandbox registrations do not
   carry over.
3. **Confirm Card Tokenisation is enabled on the live account.** Without it
   customers can pay but nothing renews itself. Switching it on does not reach
   back: an account that paid while it was off has no card stored and needs
   one more payment before it can renew. The Control Center's billing card now
   lists those accounts under "Paid, but no card kept", which is the only
   reliable confirmation — a dashboard toggle says what should happen, that
   list says what did.
4. Save, redeploy, then open the processor check below.
5. Take one small real payment before trusting it.

The server now checks these against each other at boot and warns about a test
key in live mode, a live key pointed at the sandbox, or a leftover base URL.

---

## When payments will not start

Sign in as an admin and open:

    https://profitna.com/api/orgs/<org id>/subscription/processor-check

Get the org id from `https://profitna.com/api/auth/me`. The check authenticates
against Monnify and nothing else — no charge, no transaction — and answers in
about six seconds whatever is wrong, so it always arrives rather than becoming
a proxy error page.

| What it says | What to fix |
|---|---|
| could not reach Monnify at all | The container has no outbound internet, or the host is wrong |
| answered but refused these credentials | Wrong key or secret, or live keys sent to the sandbox |
| accepted these credentials | Monnify is fine; the fault is elsewhere |

Keys are shown only as a few characters and a length — enough to spot a
swapped or truncated paste without printing a secret.

---

## When a screen will not draw

The app does not go down with one bad record. A failure is contained to the
screen it belongs to: a broken Settings leaves the dashboard, reports and
invoices working. When you are looking at the affected screen you get a panel
saying the books are safe, the one line worth sending to support, and three
ways out — back to the dashboard, reload, sign out.

That was true of Settings and nowhere else until 15 October. The eleven
sections added for payments, receivables and recurring invoices had no guard
around them at all, and any one of them could have taken the whole interface
down for everyone. All of them are now contained, the navigation itself is
guaranteed before any screen is built, and the server keeps serving through a
fault in a background timer instead of exiting.

**`npm run test:screens`** is the proof rather than the promise: 119 checks in
a real browser that visit every screen and every tab, then replace each of
nine API calls with each of five kinds of broken response — forty-five
combinations — and require that both the affected screen and the dashboard
stay usable after every one. It then kills the API outright, and finally
breaks a section on purpose to watch the net catch it.

It found three real faults the first time it ran, including one that would
have locked a business out of its own books.

---

## Still open

- **Point the off-site copy at a bucket.** The app now copies each verified
  dump to object storage as soon as it is taken, and checks it arrived — but
  only once `BACKUP_S3_*` is set in Easypanel. Until then the Control Center's
  Backups card says, in amber, that the dumps are on the same machine as the
  database. Any S3-compatible store works; Backblaze B2 is the cheapest of the
  usual ones. Set it, redeploy, press **Back up now**, and the card says where
  the copy went.
- **The billing scheduler now charges real cards** every hour it finds a term
  that has ended. Worth watching the Control Center's Subscriptions page for
  the first few renewals.

- **The read-only Settings question** on Mideops Professional Services Ltd —
  `server/diagnose-role.sql` answers it; the output has not been looked at yet.
- **Nigeria Revenue Service e-invoicing is not built**, and nothing in the
  product claims an invoice has been sent to or verified by it. Worth saying
  plainly because the opposite claim is the expensive one.
- **The repository's default branch on GitHub is `backend-for-profitna`**,
  which is months stale, and **Easypanel may still be deploying it**. This is
  the one open item with teeth: nothing breaks today, but any redeploy that
  pulls the old branch rolls the live site back past the invoicing, the
  ledger, the PDFs, the payments and the recurring invoices.

  GitHub → repo → Settings → General → Default branch → switch to `main`.
  Then Easypanel → your app service → Source → set the branch to `main` →
  Deploy. (Claude cannot do either: the GitHub proxy refuses settings writes,
  and Easypanel is on the VPS, which the build environment cannot reach.)
- **Google sign-in** is still in Testing on the consent screen, so only
  tosyn.ogunniyi@gmail.com can use it. Publish it to open it up.
- **The privacy notice could carry a registered address.** `web/privacy.html`
  is complete and served at `/privacy` and `/cookies`: Mideops Professional
  Services Ltd as the controller, the United Kingdom named as where the data
  sits, and everything else describing what the code actually does. It gives
  support@profitna.com as the contact, which satisfies the Act. A registered
  office address and RC number are not required but are usual on a Nigerian
  company's privacy notice, and worth adding when convenient.
- **The notice has not been through a lawyer.** It was written from the code
  and from the Nigeria Data Protection Act 2023 rather than from a template,
  which makes it accurate but not advised-on. Half an hour of a Nigerian data
  protection practitioner's time would be reviewing something substantive
  rather than drafting from scratch.
- **Online invoice payments need a server key.** Customers can pay a business's
  invoices through that business's own Paystack or Monnify account — but only
  once `CREDENTIALS_KEY` is set in Easypanel → your app service → Environment.
  It encrypts each tenant's payment credentials.

  **Until it is set the feature is hidden, not broken.** There is no payment
  panel in Settings and no Pay-link button on any invoice — because an amber
  box telling a customer to set a server environment variable is a message
  about a server they do not own. `GET /api/health` reports
  `merchantCredentials`, and the server says it again in the boot log; those
  are the two places that are actually yours.

  Generate one with `openssl rand -base64 32`, set it, redeploy, and **do not
  change it afterwards**: credentials already stored can only be read with the
  key that wrote them. The panel appears on its own — nothing in the code has
  to change.

  After that, each business connects its own account in Settings → "Letting
  customers pay you online": paste the keys, press Test, then copy the webhook
  URL shown there into the same provider dashboard page. The URL is unique to
  that business. Pay-link buttons appear on invoices only once an account has
  been connected *and* proved, so a button never appears before it works.

- **Tracking now waits to be asked.** The Meta pixel used to load the moment
  the server reported an id. It no longer does: nothing is fetched from Meta
  and no cookie of theirs is set until a visitor presses Allow on the banner.
  The server half obeys the same answer — the choice is a first-party cookie
  (`profitna_ads`), so it arrives with the signup and the payment, and
  `meta.trackFor()` is what both routes call so the check cannot be forgotten
  at one of them. Declines are counted separately from failures, because "no
  events" and "everyone said no" are different facts.

- **Automatic email is live.** Sending since 16 October 2026, through Hostinger
  Email as `info@profitna.com`, replies to `support@profitna.com`. A test
  message landed in a Gmail inbox rather than the spam folder, which is the
  only evidence that counts for SPF and DKIM.

  The configuration, recorded so it can be rebuilt: `EMAIL_SMTP_HOST=smtp.hostinger.com`,
  `EMAIL_SMTP_PORT=465`, `EMAIL_SMTP_USER` and `EMAIL_FROM` both
  `info@profitna.com`, `EMAIL_REPLY_TO=support@profitna.com`, `EMAIL_SENDING=on`.
  The user and the from address must be the same mailbox — Hostinger refuses
  to send as an address the authenticated mailbox does not own, and that is
  the one thing that catches people out. Mailgun, SendGrid, Amazon SES,
  Postmark, Resend and Zoho are the same variables with different values, so
  outgrowing Hostinger's hourly limits costs no code change.

  Owner console → **Email** has the outbox across every account, the counts by
  outcome, **Check credentials** (proves the login, sends nothing) and **Send
  test** (one real message, fixed body, past the sending switch).
  `GET /api/health` reports the state under `email`.

- **Nothing feeds the suppression list yet.** `email_suppressions` is built,
  honoured on every send and overrides every preference — but plain SMTP has
  no webhook, so no bounce or spam complaint reaches it automatically.
  Hostinger returns failures as delivery notices to the `info@` mailbox, which
  means somebody has to read them and suppress by hand. Harmless at current
  volume; the first thing to fix on moving to Mailgun or SES, both of which
  post the events this table was designed for.

- **Ask Profitna needs its key.** The code is live but the screen will keep
  saying "Simulated · no model connected" until `ANTHROPIC_API_KEY` is set in
  Easypanel → your app service → Environment. `GET /api/health` reports
  `askModel` once it is, and nothing else needs changing.
- **Mono's bank-connect widget** is not in the front end; the exchange,
  webhook and storage behind it are ready.
- **Secrets exposed during setup** should be rotated: the VPS root password,
  the Postgres password, the `JWT_SECRET`, and the unused Google client secret
  (which can simply be deleted in Google Cloud).

---

## Running it yourself

    createdb profitna
    cd server
    cp .env.example .env          # set JWT_SECRET
    npm install
    npm run migrate
    SEED_DEMO_DATA=true npm start # http://localhost:4000

`SEED_DEMO_DATA=true` fills each new account with eight months of sample
Nigerian books. Leave it unset in production so real accounts start empty.

Seventeen test suites, 1,322 checks, run against a live server and a real database:

| Command | Checks | Covers |
|---|---|---|
| `npm run smoke` | 145 | Signup, ledger, invoices, inventory, imports, tenant isolation, the privacy notice, and that every page the server routes is a page the image ships |
| `npm run smoke:admin` | 103 | The Control Center, its auth, its second factor and the outbox |
| `npm run test:billing` | 54 | A trial through to a charge, a decline, a retry, a recovery |
| `npm run test:monnify` | 85 | The processor, amounts, webhooks, and the live switch |
| `npm run test:ask` | 60 | What Profitna AI may read, and that its tables are the database's |
| `npm run test:backup` | 27 | A real dump, read back, copied off the machine, plus retention |
| `npm run test:offsite` | 33 | The AWS signature against AWS’s own signer, and a real upload |
| `npm run test:meta` | 50 | Ad events, consent gating, and that no readable email ever leaves the server |
| `npm run test:invoicing` | 67 | Invoice money in integer kobo, Nigerian VAT and WHT, numbering under load and across years |
| `npm run test:pdf` | 52 | A4 invoice PDFs: the naira glyph, pagination, five designs, isolation |
| `npm run test:ledger` | 62 | Double entry: balance, idempotency, reversals, closed periods, backfill |
| `npm run test:payments` | 151 | Receipts across several invoices, money on account, credit notes, gateways, webhooks, forged signatures |
| `npm run test:recurring` | 50 | Schedules: the dates, catching up, stopping, and that nobody is billed twice |
| `npm run test:email` | 89 | The lifecycle conditions, consent, idempotency, retries and unsubscribing |
| `npm run test:payroll` | 124 | Nigerian PAYE at every band boundary, pension and NHF, the year month by month, approval, posting and reversal |
| `npm run test:screens` | 154 | That no broken response can take the interface down, proved by breaking them |
| `npm run test:trial` | 16 | That changing the trial length leaves running trials alone |
