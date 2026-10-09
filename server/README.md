# Profitna — server

The backend behind `web/Profitna.dc.html`. The prototype's screens are
unchanged; what used to be sample data held in the browser now lives in
Postgres behind an authenticated, organisation-scoped API, and the same
Express process serves the app itself.

## Running it

```bash
createdb profitna                     # or point DATABASE_URL at an existing one
cp .env.example .env                  # then fill in JWT_SECRET
npm install
npm run migrate
npm start                             # http://localhost:4000
```

`npm run smoke` (against a running server) exercises signup, the ledger,
invoices and payments, inventory, statement import, subscriptions, and
tenant isolation. `npm run smoke:admin` does the same for the Control
Center, including that a tenant session cannot reach it and a Control
Center session cannot reach a tenant's books.

`npm run test:billing` runs in process and drives a trial to its end: the
charge, the period roll, a decline, the retry backoff, and paying at the
paywall — with only the payment processor stubbed.

Set `SEED_DEMO_DATA=true` to have each new account open onto the populated
books the design was built against — eight months of Nigerian sample data,
invoices, bills, stock and a bank statement. Leave it unset in production so
real accounts start empty and meet the designed empty states.

## Configuration

Everything optional is off until its key is set, and the app degrades to
what it can honestly do:

| Variable | Effect when unset |
|---|---|
| `DATABASE_URL`, `JWT_SECRET` | Required. The server refuses to sign sessions without a secret. |
| `GOOGLE_CLIENT_ID` | The Google buttons report that sign-in is not configured. |
| No payment processor | Trials still run, but an expired account cannot be paid for from the app; the paywall says so instead of offering a dead button. |
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher, which still codes most Nigerian bank narrations. |
| `MONO_SECRET_KEY` | Bank feeds are unavailable; the CSV / Excel / Sheets import path is unaffected. |
| `ADMIN_PATH` | The owner's console is served at `/admin`. |
| `ADMIN_IP_ALLOWLIST` | The console is reachable from any address. |
| `ADMIN_TOTP` | Two-factor is required. Set it to `off` only if you cannot use an authenticator app. |
| `BILLING_SCHEDULER` | Trials end and terms renew automatically. Set it to `off` to stop that. |

## How it fits together

- `src/index.js` — Express app; mounts webhooks before the JSON parser so
  signatures verify over the raw body, then the API, then the two files the
  front end is made of.
- `src/auth.js` — bcrypt + JWT in an httpOnly cookie. `requireOrg()` resolves
  `:orgId` against the caller's memberships and is the single place tenant
  scoping is decided; an organisation you do not belong to is a 404.
- `src/sql/001_init.sql` — the schema, extended from `docs/design/uploads/schema.sql`
  for church funds, per-book categories, statement lines and subscriptions.
- `src/routes/org.js` — `GET /orgs/:id/data` returns a whole book in one call,
  in the exact shape the UI already held in state. Also settings, chart of
  accounts and contacts.
- `src/routes/ledger.js` — transactions, invoices, bills, payments, inventory.
- `src/routes/bank.js` — statement import, matching, and the Mono feed.
- `src/integrations/` — Monnify, Paystack, Google, Anthropic, each behind a
  `configured()` check.
- `src/admin-auth.js`, `src/routes/admin.js`, `web/admin.html` — the Control
  Center, described below.
- `src/billing.js` — the timer that ends trials and renews terms.
- `src/access.js` — who may open the books, and until when. One middleware,
  mounted in front of the book and never in front of the subscription routes.
- `src/team.js`, `src/routes/members.js`, `src/routes/invitations.js` — who is
  on a set of books, what they may do, and how a second person gets there.
- `src/routes/banking.js` — the company's own accounts and their balances,
  and the logo its reports carry.

Two rules the schema enforces by design, carried over from the build spec:
document status is **derived** from payments and due date rather than stored,
and a contact's name is **snapshotted** onto invoices and bills so renaming or
deleting a contact never rewrites history.

## The Control Center

The platform owner's console, at `/admin`. It shows every registered account,
what each one is paying, when it renews or expires, and what has happened on
it — and it can suspend, deactivate or reinstate an account, and override a
subscription.

### Getting in

```bash
npm run create-admin -- --email you@example.com --name "Your Name"
```

That prints a generated password and a two-factor secret, once. Add the secret
to an authenticator app, then sign in at `/admin` with the email, password and
a six-digit code; the first sign-in that uses a code completes enrolment.
Change the password from the console's Security tab afterwards.

Other commands: `--list`, `--reset-password`, `--rotate-totp` (if the
authenticator is lost), `--disable` and `--enable`.

### Why it is a separate system

A tenant's `admin` role is admin *of one set of books*. Nothing about it should
ever be able to grow into "admin of the platform", so the two share nothing:

| | Customers | Control Center |
|---|---|---|
| Identity | `users` + `memberships` | `platform_admins` |
| Session | signed JWT in `profitna_session` | opaque token in `profitna_admin`, matched against `platform_admin_sessions` |
| Created by | signing up | a command run on the server |
| Second factor | none | TOTP, required |
| Lifetime | 7 days | 12 hours, or 2 hours idle |
| Audit trail | `audit_log`, per organisation | `platform_audit_log`, across all of them |

The session token is stored only as a SHA-256 hash, so the session table is not
a set of usable credentials, and a session can be ended server-side — from
another device, by changing the password, or by disabling the account.

Sign-in is rate limited per address and locks an account for 15 minutes after
five failures. A wrong password and a wrong code return the same message, so
neither says which half was right. Until an owner account exists — and for any
address outside `ADMIN_IP_ALLOWLIST` when that is set — both the page and the
API answer **404**, not 401: a deployment that has not run `create-admin`
advertises nothing to probe at. `ADMIN_PATH` moves the page only — the API
stays at `/api/admin`, behind the same gate — so treat it as tidiness rather
than a defence.

### What it changes elsewhere

- `requireAuth` now checks `users.status` on every request, so suspending an
  account ends the sessions it already has open — a signed token cannot be
  revoked, so it has to be checked against something that can.
- Every sign-in writes `last_login_at` and increments `login_count`.
- Successful and failed charges are written to `payments`, from activation,
  from `chargeDue()` and from the processor's webhook, keyed on the provider
  reference so a retried webhook does not duplicate a line.
- `expired` is **derived** from the period end and today's date, never stored —
  the same rule invoices follow. `suspended` is stored, because it is an act
  rather than a consequence.

## Bank accounts and report branding

**A bank balance is derived, never stored**: opening balance, plus everything
recorded against that account. `bank_accounts` holds the opening figure and
the date it was the balance at; `transactions.bank_account_id` says which
account a payment moved through. Cash entries deliberately carry no account,
so a counter sale does not inflate a bank balance.

`organizations.opening_cash` was one figure for the whole business. It is now
**the sum of the accounts' opening balances**, kept in step by this module, so
the dashboard, the cash series and every report carry on reading one number
without knowing it is made of several. The organisation PATCH no longer
accepts it — the profile form cannot quietly overwrite the accounts.

Where a payment lands when the entry does not say: the account it names if it
names one, otherwise the primary account for a bank method, otherwise nowhere.
`resolveAccount()` is that rule, and the manual ledger, invoice and bill
payments, stock movements and statement imports all go through it.

Removing an account **archives** it. Entries already recorded against it keep
pointing at something real, and the last account cannot be removed.

**The logo** lives in Postgres as bytes, not on disk: the app runs in a
container with no persistent volume, and a logo that vanishes on the next
deploy is worse than none. Uploads are capped at 400KB and accepted only if
the bytes really are a PNG, JPEG or WebP — the declared type is not trusted,
and SVG is refused outright because it is a document that can carry script.
It is served back with `nosniff` and a sandboxing CSP.

Reports carry that logo at the head and **Powered by Profitna** at the foot,
next to the organisation's name and the date the report was produced.

## Roles, seats and invitations

`memberships.role` has existed since the first migration and `requireOrg()`
has enforced it all along; what was missing was any way to create a second
membership. That is what `invitations` adds.

| Role | May |
|---|---|
| `admin` | Everything: books, settings, team and billing. |
| `accountant` | Enter and edit transactions, invoices, bills and reports. |
| `viewer` | Read the dashboard and reports. Nothing else. |

**A seat is a person.** Two counts are always added together before anyone
else is let in — people already on the books, and invitations still
outstanding — so a one-seat plan cannot quietly carry five people. For the
same reason seats cannot be reduced below the number in use, and the seat is
checked again when an invitation is accepted, not only when it was sent.

**Signing up for one** makes that person the admin of their own books, as
before. **Signing up for more** names the other seats in the same request:
`POST /auth/signup` takes `team: [{ email, role }]`, creates an invitation for
each inside the transaction that creates the books, and returns a link per
person. An account for three users therefore ends with one member and two
invitations, not three unexplained empty seats.

**Afterwards**, `POST /orgs/:id/members` does the same one at a time.

**There is no email delivery in this product, and none is pretended.** An
invitation produces a link the subscriber copies and sends however they
already talk to their accountant. Only the SHA-256 of the token is stored, so
the table is not a set of usable keys into other people's books; the raw token
is returned once, and "New link" issues another, which cancels the old one.

Following a link lands on `/?invite=…`, which reads
`GET /api/invitations/:token` — organisation name, role and who invited them,
and nothing about the books, because anyone holding the link can read it.
Accepting creates the person's own sign-in. If the address already has a
Profitna account it must prove itself with that account's password first: an
invitation is a way onto somebody's books, never a way into somebody's
account.

**The interface follows the role.** The app shell carries `data-role`, and
controls are tagged `data-w` (needs write) or `data-a` (needs admin); one
stylesheet rule greys them and takes them out of the click path, and the same
controls are `disabled`, so the keyboard cannot reach them either and a screen
reader announces them correctly. Read-only content is never touched — a viewer
sees every figure, just none of the controls that would change one. The API
remains the authority; this only stops the screen offering what it will refuse.

An organisation always keeps at least one admin — the last one cannot be
demoted or removed. Removing somebody frees their seat and ends their access
at their next request; it does not touch anything they entered, which belongs
to the books rather than to them.

## Signing up, the trial, and the paywall

    sign up  →  no card  →  30-day trial  →  trial ends  →  pay  →  active

The length is `TRIAL_DAYS` in `src/pricing.js` and nothing else. Changing it
moves every trial, not only the ones started afterwards: when a trial ends is
derived from `trial_start` plus that number and is never written into a row,
so there is nothing to migrate. An account part-way through simply finds it
has longer, and one whose trial had lapsed inside the new window opens again.
Accounts that have already paid carry a real `current_period_end` and are not
affected either way.

**Signing up asks for nothing to pay with.** `/auth/signup` takes a name, an
organisation, an email, a password and a plan choice, and creates a
subscription that is `trialing` from today with no card, no processor and no
charge. Anything card-shaped in the request body is ignored rather than
trusted, so an old client cannot reintroduce the card step by sending one.

**During the trial** the account is fully usable. `sessionFor()` returns the
derived facts the interface draws from — `access`, `daysLeft`, `trialEndsOn`,
`periodEnd`, `amount` — so the banner, the chrome and the paywall are counting
the same days.

**When the trial runs out** `requireSubscription` (`src/access.js`) answers
**402** for the books, and only for the books: it is mounted after the
subscription routes, because an account that cannot pay its way in still has
to be able to pay. The body carries the reason and the amount, which is what
the payment screen renders itself from. Nothing is deleted, disabled or
archived — the rows sit where they were.

**Paying** goes through `POST /orgs/:id/subscription/activate`. The browser
first asks `POST /orgs/:id/subscription/checkout`, which says which window to
open and hands back the keys, the price and a fresh unique reference. The
customer pays in the processor's own window and sends back a reference; the
server verifies it, **refuses a payment smaller than the plan costs**, and
takes the amount, the card and the reusable credential from that verification
rather than from the client. That check is what makes it safe for the browser
to name the amount at all. The term then starts where access currently runs
out — which reopens the books, since access is read from the period end and
never from a flag.

`monnify.initTransaction()` exists and is tested, but **nothing in the payment
path calls it, deliberately**. Monnify's SDK opens its own transaction and a
`paymentReference` may be used only once, so opening one server-side and then
handing the SDK that same reference makes the SDK's attempt a duplicate —
reported as "unable to process your transaction request" from inside Monnify's
window, long after this server has stopped being involved. One side opens the
transaction, never both. The function is kept for a hosted `checkoutUrl`
redirect flow, which would replace the SDK rather than run alongside it.

That last point is `rollPeriod()`, and it is deliberately not "today". A
customer who subscribes from Settings with four days of trial left keeps those
four days: the term begins when the trial would have ended. Starting it today
would bill them for days they had already been given, and the trial banner has
always promised otherwise. The same arithmetic means a renewal charged a day
late does not shorten the term, and a double payment buys two months rather
than losing one.

**Afterwards** the stored credential is what `chargeDue()` charges at each
renewal. Point the processor's webhook at `/api/webhooks/monnify` or
`/api/webhooks/paystack`.

The card number and CVV never reach this server on any path.

### Which processor

Two are supported and exactly one runs at a time. `PAYMENT_PROVIDER` settles
it (`monnify` or `paystack`); left unset, whichever has its keys filled in is
used, and Monnify wins if both do — a deployment that has just moved over
usually still has the old Paystack keys lying about. Naming a provider that
is not configured leaves the app with no processor rather than quietly
billing through the other one.

Everything above `src/integrations/gateway.js` is unaware of the choice. Both
modules expose the same four functions and `verify()` returns the same shape,
with the reusable credential — Paystack's authorization code or Monnify's
card token — in the same field.

**Monnify specifics worth knowing:**

- **Amounts are in naira**, as a decimal. Paystack works in kobo. Nothing in
  this codebase multiplies by 100 for Monnify, and adding it would charge a
  customer a hundred times over.
- **Renewals need Card Tokenisation enabled** on the merchant account — ask
  Monnify support to turn it on. Without it customers can still pay, but no
  card is kept and nothing auto-renews. A payment that comes back without a
  token still activates the account; it just will not renew itself.
- **Every call needs a bearer token** fetched with the API key and secret.
  It is cached, shared across concurrent calls, and refreshed once on a 401.
- `MONNIFY_API_KEY` and `MONNIFY_CONTRACT_CODE` reach the browser. They are
  public by design and authorise nothing alone; the secret key never leaves
  the server.
- A card stored with one processor is never sent to the other. `chargeDue()`
  checks `subscriptions.provider` and declines to try, because the token
  means nothing to them and the customer would see a decline on a good card.

**Going live.** Monnify's sandbox and live dashboards are separate accounts
with separate keys *and separate contract codes*, so all four values change
together:

    MONNIFY_ENV=live
    MONNIFY_API_KEY=MK_PROD_...
    MONNIFY_SECRET_KEY=...
    MONNIFY_CONTRACT_CODE=...

The value is whatever follows the `=`, bare: no quotes, no brackets, no
spaces. The server strips those if it finds them and warns that the setting
is still wrong, but a wrapped value is otherwise indistinguishable from a
wrong key — it reaches Monnify verbatim and comes back "invalid
 credentials".

`MONNIFY_BASE_URL` overrides `MONNIFY_ENV` completely; unset it unless you are
deliberately pointing at a test double. Register the webhook again in the live
dashboard — sandbox registrations do not carry over — and confirm Card
Tokenisation is enabled on the live account, or payments will work and
renewals will not.

The server checks these against each other at boot and prints a warning for
each mismatch: a test key in live mode, a live key pointed at the sandbox, a
leftover base URL. The same warnings come back from the processor check below.
They catch the mistakes that otherwise surface as a real customer's card
failing.

**Why 424 and not 502.** When the payment processor will not answer, the
checkout route replies **424 Failed Dependency**, which is a 4xx on purpose.
A reverse proxy will replace a 5xx body from the app with its own HTML error
page, so every carefully worded message about Monnify reached the customer as
"the server did not answer" instead. 4xx is passed through untouched. Keep
deliberate, user-facing failures in the 4xx range for that reason; genuine
unexpected bugs can stay 500, where the front end's own fallback covers them.

**Is the deploy live, and is it healthy?** `GET /api/health` needs no sign-in
and answers three questions that otherwise take guesswork: `uptimeSeconds`
(a small number means it restarted just now, which is the difference between
"my change is not deployed" and "it crashed again"), `db` and `dbMs` (whether
Postgres is answering and how fast), and `trialDays` / `paymentProvider`,
which move with the code so a stale deploy shows up without digging. It
carries no secrets and no configuration.

**When payments will not start**, sign in as an admin and open

    /api/orgs/<organisation id>/subscription/processor-check

It authenticates against Monnify and nothing else — no charge, no transaction
— and answers within about six seconds whatever happens, so it beats any
proxy's patience and cannot come back as somebody else's HTML error page.
Three answers, three different fixes:

| `result` says | Fix |
|---|---|
| could not reach Monnify at all | The container has no outbound internet, or `MONNIFY_ENV` names the wrong host |
| answered but refused these credentials | Wrong key or secret, or live keys pointed at the sandbox |
| accepted these credentials | Payments are fine; the fault is elsewhere |

Keys are shown only as a first few characters and a length, which is enough to
spot a swapped or truncated value without printing it.

`locked` is derived, like document status and subscription expiry: a stored
flag would be correct only until the next midnight nothing ran through.

## Backups

`src/backup.js` takes a `pg_dump` on a schedule, inside the server process and
under its own advisory lock, so more than one container does not dump at once.
Defaults: every 24 hours into `/data/backups`, keeping 14 days.

It asks on each tick whether the newest dump has aged out rather than firing
at a fixed hour. A container that restarts overnight would miss a fixed hour
entirely and nobody would find out until the day the backup was needed; this
way the schedule heals itself.

Three things it does that a one-line cron job usually does not:

- **Verifies.** `pg_restore --list` has to read the table of contents before
  the file is accepted. An unverified backup is a guess.
- **Writes under a temporary name** and renames only after that check passes,
  so a half-written file is never left looking like a backup.
- **Never deletes the last one.** However far past retention it is, an old
  backup beats none — a database that has stopped dumping should not erase
  its own history as well.

The Control Center's **Subscriptions** page carries a **Backups** card beside
automatic billing — both are things that run on their own and are only noticed
once they have quietly stopped. It shows the state, how old the newest dump
is, both Postgres versions, and a **Back up now** button.

`GET /api/admin/backups` reports whether `pg_dump` is present, whether the
directory can actually be written to, how old the newest dump is, the last
attempt and why it failed if it did, one `healthy` boolean and one `note`
saying what to do about it. A schedule nobody can see is a schedule nobody
notices has stopped, and `healthy: false` with no reason is barely better.

`POST /api/admin/backups/run` takes one immediately. Waiting a day to find out
whether backups work is a day of not knowing.

**The client must be at least as new as the database.** `pg_dump` reads older
servers back many versions and refuses a newer one outright, so the Dockerfile
asks for the newest client first and falls back. Pinning it to the version in
`docker-compose.yml` is the trap: a managed database elsewhere may be ahead of
it, and the first sign is every nightly dump aborting. The server compares the
two at boot and the console reports it, so this is visible rather than
discovered the night it matters.

The commonest reason for `writable: false` is a volume mounted at
`/data/backups` arriving owned by root while the app runs as uid 1000. The
endpoint says so rather than leaving it to be guessed.

**What this does not do, and you should.** The dumps sit on the same machine
as the database. That covers a bad migration, a wrong `DELETE`, a corrupted
table — but not losing the server. Copy them somewhere else on a schedule of
your own:

```bash
# From anywhere with SSH to the host, nightly:
docker compose cp app:/data/backups ./profitna-backups
```

and keep them somewhere that is not that machine. Restoring is:

```bash
createdb profitna_restored
pg_restore --no-owner --no-acl -d profitna_restored profitna-<stamp>.dump
```

That restore has been exercised, not assumed: `npm run test:backup` takes a
real dump and reads it back, and the full round trip into an empty database
was checked row-for-row across every table.

## Automatic billing

`src/billing.js` is what makes a trial end. It runs inside the server process
on a timer (`BILLING_INTERVAL_MINUTES`, default 60) and stays idle until a
payment processor is configured, so a deployment without one charges nothing
rather than failing loudly every hour.

Each pass takes a Postgres **advisory lock**, so running more than one
container does not charge the same card twice, and it charges at most
`BILLING_BATCH` (50) subscriptions, so a backlog after downtime drains over
several passes instead of firing hundreds of charges at once.

**What is due:** a subscription whose term has run out —
`COALESCE(current_period_end, trial_start + TRIAL_DAYS) <= today` — that is still
`trialing`, `active` or `past_due` and has an authorisation code. Cancelled
and suspended subscriptions are never charged, and neither is one with no card
on file — which, since signup no longer collects one, is every account that
has not yet paid at the paywall. Those are locked out rather than billed.

**When it succeeds**, `chargeDue()` writes a `payments` row, moves the
subscription to `active`, and rolls `current_period_start` / `_end` forward a
month or a year.

**When the card is declined**, the subscription goes `past_due`, the failed
charge is recorded with the reason the processor gave, and it is retried after
1, then 3, then 5, then 7 days. After the fourth attempt it stops and leaves
the subscription `past_due` for a human. Ending someone's books because a card
expired is the owner's decision, not a timer's — the Control Center shows
every one of these on the Subscriptions page, with the attempt count and the
last error.

The owner can also run a pass on demand from that page ("Run now"), which is
the same code path, recorded in `billing_runs` and in the platform audit log.

`npm run test:billing` exercises the whole path — due list, successful charge,
period roll, payment row, decline, retry backoff, giving up, and recovery —
against the real database with only the processor stubbed.

| Variable | Effect |
|---|---|
| `BILLING_SCHEDULER=off` | The timer never starts. "Run now" still works. |
| `BILLING_INTERVAL_MINUTES` | How often a pass runs. Default 60. |
| `BILLING_BATCH` | Most subscriptions charged in one pass. Default 50. |

## Deploying

The app is one Node process plus Postgres, so Render, Railway and Fly all fit.
Set the env vars, run `npm run migrate` on release, and serve behind HTTPS.
The session cookie is marked `secure` whenever the request arrived over HTTPS,
including through a reverse proxy, so it does not depend on `NODE_ENV` being
remembered.

The front end loads React and the spreadsheet reader from `web/vendor/`
rather than a public CDN, so the app boots without third-party availability.
Google Fonts is still fetched over the network and falls back to system fonts
if it is unavailable.

## Not wired yet

- Mono's Connect widget needs adding to the front end; the exchange, webhook
  and storage are in place behind `MONO_SECRET_KEY`.
- WhatsApp and email delivery are UI-only, as the design intends — no
  integration claims are made anywhere in the product.
- Nothing outstanding on roles: the API enforces them, the product assigns
  them, and the interface greys out what a role cannot reach.
- Control Center accounts are created at the command line only — there is no
  invite flow and no "add another owner" screen, on purpose. A console that
  can mint its own administrators is a console one stolen session can keep.
