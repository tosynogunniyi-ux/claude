# Where Profitna stands

A plain-language record of what has been built, what is live, and what is
still waiting on somebody. Kept in the repository so it is always reachable:
**github.com/tosynogunniyi-ux/claude → `docs/STATUS.md`**.

Last updated 9 October 2026. **Monnify is live and the first real payment
has gone through.**

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
   customers can pay but nothing renews itself.
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

The app no longer goes down with one bad record. A failure is contained to the
screen it belongs to: a broken Settings leaves the dashboard, reports and
invoices working. When you are looking at the affected screen you get a panel
saying the books are safe, the one line worth sending to support, and three
ways out — back to the dashboard, reload, sign out.

---

## Still open

- **Copy the backups off the machine.** Nightly dumps run, are verified, and
  show up in the Control Center under Subscriptions → Backups. They sit on the same VPS as the database. That covers a bad
  migration or a wrong `DELETE`; it does not cover losing the server. A
  scheduled `docker compose cp app:/data/backups ...` to anywhere else closes
  it. Check `GET /api/admin/backups` says `healthy: true` after the first
  night.
- **The billing scheduler now charges real cards** every hour it finds a term
  that has ended. Worth watching the Control Center's Subscriptions page for
  the first few renewals.

- **The read-only Settings question** on Mideops Professional Services Ltd —
  `server/diagnose-role.sql` answers it; the output has not been looked at yet.
- **The repository's default branch on GitHub is `backend-for-profitna`**,
  which is months stale. All work is on `main`. Worth checking Easypanel
  deploys `main`, and worth changing the default so nothing deploys the old
  branch by accident.
- **Google sign-in** is still in Testing on the consent screen, so only
  tosyn.ogunniyi@gmail.com can use it. Publish it to open it up.
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

Seven test suites, 414 checks, run against a live server and a real database:

| Command | Checks | Covers |
|---|---|---|
| `npm run smoke` | 98 | Signup, ledger, invoices, inventory, imports, tenant isolation |
| `npm run smoke:admin` | 86 | The Control Center, its auth and its second factor |
| `npm run test:billing` | 49 | A trial through to a charge, a decline, a retry, a recovery |
| `npm run test:monnify` | 84 | The processor, amounts, webhooks, and the live switch |
| `npm run test:ask` | 60 | What Profitna AI may read, and that its tables are the database's |
| `npm run test:backup` | 21 | A real dump, read back, plus retention and the ways it fails |
| `npm run test:trial` | 16 | That changing the trial length leaves running trials alone |
