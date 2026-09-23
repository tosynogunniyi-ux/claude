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
| `PAYSTACK_SECRET_KEY` + `PAYSTACK_PUBLIC_KEY` | Trials still run, but an expired account cannot be paid for from the app; the paywall says so instead of offering a dead button. |
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
- `src/integrations/` — Paystack, Google, Anthropic, each behind a
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
  from `chargeDue()` and from the Paystack webhook, keyed on the provider
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

    sign up  →  no card  →  14-day trial  →  trial ends  →  pay  →  active

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
pays in Paystack's own window and sends back a reference; the server verifies
it, refuses a payment smaller than the plan costs, and takes the amount, the
card and the reusable authorisation from that verification rather than from
the client. The term then starts today, which is what reopens the books —
access is read from the period end, never from a flag.

**Afterwards** the stored authorisation is what `chargeDue()` charges at each
renewal. Point the Paystack webhook at `/api/webhooks/paystack`.

The card number and CVV never reach this server on any path.

`locked` is derived, like document status and subscription expiry: a stored
flag would be correct only until the next midnight nothing ran through.

## Automatic billing

`src/billing.js` is what makes a trial end. It runs inside the server process
on a timer (`BILLING_INTERVAL_MINUTES`, default 60) and stays idle until
`PAYSTACK_SECRET_KEY` is set, so a deployment without a processor charges
nothing rather than failing loudly every hour.

Each pass takes a Postgres **advisory lock**, so running more than one
container does not charge the same card twice, and it charges at most
`BILLING_BATCH` (50) subscriptions, so a backlog after downtime drains over
several passes instead of firing hundreds of charges at once.

**What is due:** a subscription whose term has run out —
`COALESCE(current_period_end, trial_start + 14) <= today` — that is still
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
