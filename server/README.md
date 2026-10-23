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
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher, which still codes most Nigerian bank narrations, and Ask Profitna says so on the screen and answers six set questions from the figures already on the page. |
| `META_PIXEL_ID` | No ad tracking at all: no script fetched from Meta, no cookie set, nothing sent. |
| `MONO_SECRET_KEY` | Bank feeds are unavailable; the CSV / Excel / Sheets import path is unaffected. |
| `ADMIN_PATH` | The owner's console is served at `/admin`. |
| `ADMIN_IP_ALLOWLIST` | The console is reachable from any address. |
| `ADMIN_TOTP` | Two-factor is required. Set it to `off` only if you cannot use an authenticator app. |
| `BILLING_SCHEDULER` | Trials end and terms renew automatically. Set it to `off` to stop that. |
| `EMAIL_SMTP_HOST` etc. | Automatic email is decided and recorded but not sent. The outbox holds what would have gone out, with the reason on each row. |
| `EMAIL_SENDING` | Messages are held rather than sent even with a provider configured. Set it to `on` deliberately, after reading the outbox. |
| `EMAIL_SCHEDULER` | The lifecycle pass runs every 15 minutes. `off` stops it. |
| `RECURRING_SCHEDULER` | Recurring invoices raise themselves hourly. Set it to `off` to stop that; schedules can still be run by hand. |
| `SCREENS_REQUIRE_BROWSER` | `npm run test:screens` skips when no Chromium is present. Set it to `1` in CI so a missing browser fails the run instead of quietly not checking that the interface cannot be taken down. |
| `CREDENTIALS_KEY` | Online collection is **hidden**, not broken: the Settings panel and every Pay-link button are absent, and nothing is stored in the clear as a fallback. The boot log and `/api/health` say why. Setting the variable brings the panel back on its own. |
| `PUBLIC_BASE_URL` | The webhook URL a tenant pastes into their provider's dashboard is built from the request's own host. Set it when the app sits behind a proxy that rewrites `Host`. |
| `GATEWAY_TIMEOUT_MS` | Calls out to a tenant's gateway give up after 8 seconds, under the proxy's own patience, so our explanation reaches the browser instead of the proxy's error page. |

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
- `src/ai/books.js`, `src/ai/ask.js`, `src/routes/ai.js` — Ask Profitna,
  described below.

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

    sign up  →  no card  →  14-day trial  →  trial ends  →  pay  →  active

`TRIAL_DAYS` in `src/pricing.js` is the length a **new** sign-up gets. Each
subscription records the length it was created with in
`subscriptions.trial_days`, and every read prefers that, so changing the
default changes the next sign-up and nothing that is already running.

It did not always work that way, and the reason it does now is worth keeping.
The length used to be derived from the constant alone. Raising 14 to 30 that
way reached everybody mid-trial, which is a gift nobody objects to. Lowering
it the same way would have locked out an account twenty days into a thirty-day
trial on the night of the change, after telling it all week it had ten days
left. Lengthening and shortening are not symmetrical, and only one of them is
safe to apply retroactively.

Rows from before the column fall back to the current default, and accounts
that have already paid carry a real `current_period_end` and never consult it.

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

### Getting them off the machine

A dump on the same machine as the database covers a bad migration, a wrong
`DELETE` or a corrupted table. It does not cover losing the server, which is
the failure people actually mean when they say "backups".

So each verified dump is copied to object storage as soon as it is taken.
Anything that speaks the S3 API will do — Backblaze B2, Cloudflare R2, Wasabi,
DigitalOcean Spaces, MinIO, AWS. That is deliberate: a second copy exists so
it does not share a fate with the first, so it should not have to share a
supplier with it either.

```
BACKUP_S3_BUCKET=profitna-backups
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com   # not needed on AWS
BACKUP_S3_REGION=us-west-004
BACKUP_S3_PREFIX=nightly                                     # optional
```

Set those, redeploy, and press **Back up now** in the Control Center — the
card then says where the copy went, or why it did not. Four things worth
knowing:

- **It is verified, not assumed.** After the upload it asks the store how big
  the object is and compares. A `PUT` that answers 200 and keeps nothing is a
  thing that happens.
- **A failed copy never fails the backup.** The local dump is taken and
  checked before the copy is attempted; discarding it because somebody else's
  endpoint was down would turn a small problem into a real one. The failure is
  logged loudly and shown on the card instead.
- **No SDK.** The AWS signature is sixty lines of HMAC against `crypto` and
  `fetch`, so this costs no dependency tree. `signature()` is checked byte-for-
  byte against vectors produced by **botocore, AWS's own signer** — see
  `test/offsite.js`. Testing it against my own understanding of SigV4 would
  have proved only that I am consistent.
- **Single request, no multipart.** Fine well past the size this database
  will reach for years; over `BACKUP_S3_MAX_BYTES` (200MB) it refuses and says
  to use rsync instead rather than silently half-uploading.

If you would rather not use object storage at all, the manual equivalent is:

```bash
# From anywhere with SSH to the host, nightly:
docker compose cp app:/data/backups ./profitna-backups
```

Either way, keep them somewhere that is not that machine. Restoring is:

```bash
createdb profitna_restored
pg_restore --no-owner --no-acl -d profitna_restored profitna-<stamp>.dump
```

That restore has been exercised, not assumed: `npm run test:backup` takes a
real dump and reads it back, and the full round trip into an empty database
was checked row-for-row across every table.

## Ask Profitna

The question box on the AI screen. It answers from one organisation's books
and from nothing else.

A turn runs like this:

1. **A snapshot goes out with the question.** `src/ai/books.js` builds it from
   SQL aggregates — twelve months of income and expenses, the top categories,
   who owes what and what is overdue, cash and bank balances, stock, fund
   balances on church books. It is about 1,300 tokens on a set of books with
   8,000 entries, because it is totals rather than rows, so it can be sent
   every time. Ordinary questions are answered from it with no lookup at all.
2. **Five read-only lookups are offered** for what the snapshot cannot
   answer: individual entries, totals for an arbitrary period, invoices and
   bills, one party's whole history, and stock. The model never writes SQL and
   never names a table. Each lookup builds its own statement from bound
   parameters with `organization_id` already fixed by the route, and caps what
   it returns at 50 rows.
3. **At most four rounds of that.** On the last one the lookups are withheld,
   so there is nothing to do but answer — a model that kept asking could
   otherwise run until the timeout.
4. **The table under the answer is the lookup's own rows.** The prose is the
   model's; every figure in that table came out of the database. That is the
   whole claim the screen makes, and it is enforced by where the rows are
   built rather than by asking the model nicely.

What it will not do: invent a figure, act on anything written in a narration
(the standing instructions say those are data, never instructions), or answer
with markdown, which the answer card would show literally.

Costs and limits are in the configuration table above: `ASK_MODEL`,
`ASK_EFFORT`, `ASK_DAILY_LIMIT`. The daily cap is counted from the audit log
rather than from memory, so restarting the container does not reset it. The
question itself is **not** recorded — only its length, how many rounds it
took and what it cost. Nobody operating the server has a reason to read what
a customer asked about their own books.

`GET /orgs/:id/ai/status` says whether a model is connected and which one;
the screen's pill reads from it rather than claiming either. Every failure
answers in the 4xx range, for the reason in the Monnify section: a proxy
replaces a 5xx body with its own HTML page and the sentence never arrives.

`npm run test:ask` covers it — 60 checks, including the lookups against books
with figures chosen so every total can be checked by hand, and the loop
itself against a scripted model, so it runs without an API key.

## Meta ads tracking

Two halves report the same events, and that is the point rather than an
accident.

The **pixel** runs in the browser. It is the half Meta documents first and the
half that goes missing: ad blockers, iOS tracking prevention, a tab closed
before the script finishes. Somewhere between a quarter and a half of real
visitors never report through it.

The **Conversions API** half runs here, in `src/integrations/meta.js`. It is
not blockable, and more importantly it fires on what the server *knows*: a
`Purchase` goes out after `gateway.verify()` has confirmed the payment with
Monnify, not when a browser claims a payment happened.

Both halves send the same `event_id` for the same action, and Meta keeps one.
Without that shared id the two halves double-count every conversion; with it,
a blocked browser event costs nothing. The ids:

| Event | Where | `event_id` |
|---|---|---|
| `PageView` | browser | — |
| `InitiateCheckout` | browser | per click |
| `CompleteRegistration` | **both** | `signup-<user id>` |
| `Purchase` | **both** | `purchase-<processor reference>` |

Using the processor's own reference means a customer who activates twice — a
double click, a retried request — is still one purchase at Meta's end.

**What leaves this server.** An email address, a first and last name and the
user id, each SHA-256 hashed after normalising the way Meta specifies, plus
the IP, the user agent, and the `_fbp` / `_fbc` cookies Meta itself set on our
domain. Never a raw address, never a card, never anything about the contents
of a customer's books. `npm run test:meta` asserts that no readable email or
name appears anywhere in an outgoing request, which is the check worth having
because everything else can be right while that one thing is wrong.

**It cannot break a signup.** `track()` is never awaited and never throws. If
Meta is slow, down, or rejecting the token, the customer's signup and payment
proceed untouched; the failure is logged and shown in the Control Center.

Setup is three values — see `.env.example`. Keep `META_TEST_EVENT_CODE` set
until you have watched events arrive in Events Manager → Test Events, then
remove it: while it is set **nothing reaches your ad reporting**, which looks
identical to working. The server warns about that at every boot.

`GET /api/admin/billing` reports the state under `meta`: whether it is
configured, which pixel, how many events have been sent and failed, the last
result, and whether test mode is still on.

## The general ledger

Profitna kept a single-entry cash book: `transactions` rows with a type and a
category, every report derived from them. That cannot express a receivable,
cannot hold output VAT apart from revenue, and cannot produce a balance sheet.
Accrual invoicing needs all three, so there is now a real double-entry ledger —
**alongside** the cash book, not instead of it. Nothing in `transactions` was
moved, rewritten or deleted, and every report that read it still reads it.

    accounts             chart of accounts, one per organisation
    journal_entries      what happened, and what caused it
    journal_lines        the debits and credits

**Three things the database guarantees, not the code.** Every entry balances —
a deferred constraint trigger, so an entry written by any future code path or
by hand is checked too. A line is a debit or a credit, never both. And a
document cannot post twice: `source_key` ('invoice:<id>:issue') carries a
unique index, so a retried request, a replayed webhook or a backfill run twice
all collapse to one entry. Duplicate revenue is the characteristic failure of
accounting integrations and a check-then-insert does not prevent it.

**Corrections are reversals.** A posted entry is immutable; to undo it you
post its mirror and both stay. A reversal carries its own date, so a March
correction to a January entry lands in March — which is what an auditor
expects and what a closed January requires.

**Closed periods.** `organizations.books_locked_through` refuses anything
dated on or before it, so last year's filed accounts cannot move.

### Posting rules

| When | Entry |
|---|---|
| Invoice issued | Dr Accounts Receivable · Cr revenue per line · Cr Output VAT |
| Payment received | Dr bank (or Gateway Clearing) · Cr Accounts Receivable |
| Bill received | Dr expense · Cr Accounts Payable |
| Direct sale | Dr bank · Cr revenue |
| Direct expense | Dr expense · Cr bank |

A payment never re-posts revenue — that was recognised when the invoice was
issued. Posting it twice is the classic double count, and `test:ledger`
asserts the income accounts do not move when cash arrives.

### Catching up

`src/accounting/backfill.js` posts everything that predates the ledger, in
order — opening balances, invoices, bills, payments, then the cash book, so a
payment never settles a receivable that does not exist yet. It is idempotent,
batched, takes an advisory lock, and runs twenty seconds after boot.

`GET /api/orgs/:id/ledger/health` says whether it has caught up and whether
the trial balance balances. `POST .../ledger/post-pending` does one
organisation now.

    GET  /api/orgs/:id/ledger/trial-balance      ?from= &to=
    GET  /api/orgs/:id/ledger/profit-and-loss    accrual
    GET  /api/orgs/:id/ledger/balance-sheet      ?asOf=
    GET  /api/orgs/:id/ledger/receivables        ageing, reconciled to the ledger
    GET  /api/orgs/:id/ledger/accounts/:id       one account's movements

### Three faults found on real data

Worth recording because each balanced perfectly while being wrong.

**Payments with no cash-book row.** The payment route writes both an
`invoice_payments` row and a `transactions` row, but the demo seeder and any
direct import write only the payment. The backfill read the cash book alone,
so 396 of 426 invoice payments were invisible and left receivables open
against money that had arrived. The trial balance still balanced — which is
why receivables are now reconciled against the ledger explicitly, and why
that check is its own line in the response.

**New organisations had no chart of accounts.** The migration seeded every
organisation that existed when it ran; signup was never taught to do the
same. The first invoice on any new account failed with "no receivable
account". The seed and the migration now read from one list.

**Two accounts with the same name.** The system chart has "Other Income" and
so does the default category list, so a P&L listed it twice and a lookup by
name could land on either. Migration 010 merges them and a unique index on
(organisation, type, lower(name)) stops it recurring.

`npm run test:ledger` — 62 checks. Verified on the full local database: 138
organisations, 13,807 entries, 27,615 lines, every balance sheet balancing and
every receivable reconciling.

## The invoicing screens

**Sales → Invoicing** is the dashboard: ten metric cards, invoiced against
collected by month, receivables ageing, who owes the most, what is overdue,
what was recently paid, and a searchable table with status, balance and a PDF
on every row. Every figure comes from `GET /invoicing/dashboard`, computed
from that organisation's own rows with the window stated on the screen, so
nothing on the page is a number whose meaning has to be guessed.

Two things it says that most dashboards do not. Recurring invoices read
"— not set up yet" rather than 0, because zero would claim none are running
when the feature does not exist. And if receivables stop reconciling with the
ledger, the screen says so in red instead of quietly showing two different
totals for what is owed.

**The builder** opens over it. Company identity, customers, products,
templates and the next invoice number arrive in one call, so the form is never
half-populated while a second request is in flight. A business with a blank
address or TIN is told those will print blank, with a link to Settings, rather
than finding out from a customer.

**The totals are the server's.** Every keystroke in the line grid is sent to
`POST /invoices/preview` and the figures come back. Two implementations of
Nigerian VAT would agree until the day they did not, and the day they do not
is the day an invoice disagrees with its own PDF.

    GET  /orgs/:id/invoicing/dashboard   every figure on the screen
    GET  /orgs/:id/invoicing/list        filtered, searched and paged server-side
    GET  /orgs/:id/invoices/new          what the builder opens with
    POST /orgs/:id/invoices/build        create or update, with lines
    POST /orgs/:id/invoices/preview      totals while typing
    GET  /orgs/:id/invoices/:id/full     an invoice, its lines and its timeline

A draft takes no number from the series, so an abandoned one leaves no hole.
An issued invoice cannot be edited — it answers 409 and says to issue a
credit note — and it posts to the ledger once, inside the same transaction
that wrote it.

### Three faults the UI work found

**A binding collision.** The invoicing vals were keyed `inv`, which the invite
screen already used, and `...this.authVals()` is spread in afterwards — so
every figure silently rendered blank while the layout looked perfect. Renamed
to `sales`.

**Bare table tags.** The runtime maps `<td>` to `sc-raw-td`; a plain `<td>`
renders as loose text. The invoice table came out as a run-on paragraph with
all the right content and no grid.

**No way to register for VAT.** `vat_registered` existed and defaulted to
false, and nothing could set it — so 7.5% could never have been applied to
anything. The smoke suite found it by asserting VAT appeared and getting
zero. `PATCH /orgs/:id` now carries it, along with the address, phone, email,
website, TIN and RC number an invoice has to print.

## Automatic email

Profitna had never sent an email. That was deliberate and stated throughout —
invitations produce a link to copy, and nothing claimed to send mail — so this
is the first time an address is used for anything, and it is built in
proportion to that.

Everything here runs now except the last hop. With no mail provider
configured, messages are decided, rendered and recorded with "no mail provider
is configured" on the row. They are not marked sent, not thrown away, and the
moment credentials appear they are there to be read before anything goes out.

### Nothing is queued in advance

This is the one design decision everything else follows from, and the brief
asked for it in a sentence: messages must be conditional, not blindly sent on
every listed day.

The obvious build is a queue — somebody signs up, schedule the day-3 email for
three days' time. It is wrong. By day 3 the person may have activated, paid,
been suspended, asked to hear nothing, or closed the account, and the queued
message knows none of it. Patching that means chasing every queued row
whenever anything changes, and the one you forget is the one that tells a
paying customer their trial is about to expire.

So nothing is queued. The pass asks, for each organisation, **what is true
now**, and a step is due only if its condition holds at the moment of sending.

That is also the whole of requirement E. Somebody who pays on day 9 never
receives the day-10 message, the expiry reminder or the expiry notice — not
because something cancelled them, but because every trial condition tests
"still trialing and unpaid" and a paid account answers no. No mechanism was
needed; it falls out of asking the question late rather than early.

Each condition is a pure function of `(signals, now)`, which is why most of
`test:email` needs no database, no clock and no mail server. A lifecycle
system whose conditions cannot be tested in isolation will email the wrong
person eventually.

### The sequence, and what makes each one conditional

| When | Message | Sent only if |
|---|---|---|
| Registration | Welcome and the first step | Always, within 3 days of signup |
| 24h | Setup assistance | **Nothing recorded yet** — not merely "has not logged in" |
| Day 3 | Offer of help | Still not activated, still trialing, not paid |
| Day 6 **after activating** | Feature guidance | Activated, and measured from the activation, not the signup |
| Day 10 | Where the trial stands | Still trialing, **no card on file**, not paid |
| 48h before expiry | The expiry reminder | Still trialing and unpaid, on **this subscription's own** end date |
| At expiry | Account status | Trial actually ended, still unpaid |
| After confirmed payment | Paid onboarding | A payment row exists and the processor confirmed it |
| A week after paying | One more note, then silence | Still active |
| Each failed charge | What the bank said, one per attempt | Keyed by attempt number |
| After the last retry | We have stopped trying | Status is past due |

"Activated" means the business recorded something real — a transaction, an
invoice or a bill. Derived, not a column somebody has to remember to set.

The expiry date is **this subscription's own**: `trial_start` plus the
`trial_days` stored on the row, not today's constant. The default went 14 → 30
→ 14, and each account keeps the promise made when it signed up. A test
asserts a 30-day trial is reminded on day 28 and is *not* told on day 12 that
it is about to end.

The day-6 guidance is chosen from what the business is **not** using yet — no
bank account, invoices but no payments recorded, invoices raised by hand every
month. A business already doing all of it is pointed at its reports rather
than sold something. That is what makes it guidance instead of a newsletter.

### Nothing fires months late

Each step has an upper bound as well as a lower one, and there is a hard
backstop: nothing is sent about an event older than `EMAIL_MAX_EVENT_AGE_DAYS`
(3). Without it, switching this on would have sent every organisation ever
created whichever step its age happened to land in — a day-3 nudge to somebody
who signed up last year. A test asserts an account created 400 days ago
qualifies for nothing at all.

### Idempotency

One message per `(organisation, kind, dedupe_key, user)`, with a unique index
behind it. The key carries whatever makes an occurrence distinct — the trial
end date, the charge attempt number — so a second trial produces a second
reminder and a retried pass does not. Five simultaneous passes write one row
between them, and the database refuses a duplicate inserted by hand.

### Retries, and the difference between a blip and a wall

A wrong password retried four times is four more wrong passwords, and a
mailbox that does not exist never will. So failures are classified:

- **Temporary** (4xx, a reset connection): retried five times over about a day
  and a half, widening each step.
- **Permanent** (5xx, no such user, authentication failed): given up on at
  once, **and the address is suppressed** — which is what protects the sending
  domain's reputation, and the reputation is shared by every customer on it.
- **Held** (no provider, sending switched off): not an attempt, so it does not
  consume one. These are not already exhausted when a provider appears.

### Consent, and the line the law actually draws

Three categories, declared with their justification attached, because the
sender refuses to send a message whose category it does not recognise:

| | Basis | Default | Can be switched off |
|---|---|---|---|
| **About your account** | contract | on | **No** — see below |
| **Help getting started** | legitimate interest | on | Yes, one click |
| **News and offers** | **consent** | **off** | Yes |

Nothing in the lifecycle above is marketing. The category exists so that
nothing can later be added and quietly treated as onboarding.

Account messages cannot be switched off, and the preferences page says so
rather than offering a switch that does nothing: somebody who stops them stops
learning that their card failed, which is not a kindness. Unsubscribing from
everything stops the optional categories and not those. Closing the account
stops everything.

**Suppression is different from preference, and overrides it.** A hard bounce
or a spam complaint belongs to the *address*, outlives the account, survives
deletion and recreation, and stops everything including account messages.
Continuing to send to somebody who reported you is how a domain gets blocked.

### Unsubscribing

- A 256-bit token in the path identifies the person. No session — demanding
  one is how an unsubscribe link becomes a spam complaint — and no way to
  enumerate an address or guess at somebody else's preferences.
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers, so one-click works.
  Gmail and Yahoo both require it of bulk senders now.
- The link unsubscribes **immediately** rather than showing a confirmation.
  Making somebody click twice is how an unsubscribe becomes a complaint; the
  undo on the resulting page is what makes that safe.
- An unknown or malformed token changes nothing, says so, and returns 200 —
  a 4xx here is replaced by the proxy's own error page, which would leave the
  person believing they are still subscribed.

### Quiet hours

Account messages go when they happen; a card failing at 02:00 is news at
02:00. Optional ones wait for 08:00–20:00 West Africa Time, with a few minutes
of jitter so a thousand accounts do not all send on the same second.

### Switching it on

Two variables, deliberately separate:

1. `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM` —
   any provider that speaks SMTP (Zoho, Mailgun, SendGrid, Amazon SES,
   Postmark, Resend). Port 587 for STARTTLS or 465 for implicit TLS; the code
   derives which from the port, because getting that wrong fails as a timeout
   and tells nobody anything.
2. `EMAIL_SENDING=on`.

Keeping them apart is what makes the first deployment safe. Credentials can be
in place and proved while sending is still off, so the outbox fills with
exactly what would have gone out and somebody can read it before a single
customer hears from us.

**The sending domain needs SPF and DKIM published before anything reaches an
inbox rather than a spam folder.** That is DNS, not code, and no amount of
correct software substitutes for it.

`/api/health` reports both states. `npm run test:email` — 89 checks.

## Not being locked out of your own books

The whole interface is one function, and everything it builds it builds on
every render — whatever screen is showing. So a section that throws because
one figure came back in an unexpected shape does not break its own screen. It
breaks the entire app, and a reload reproduces it, because the fault lives in
the data rather than in the page. That is being locked out of your own books
by a bad row, and it is the worst failure this product can have: worse than a
wrong number, because a wrong number can at least be seen.

Three layers stop it, and a suite that proves each one fires.

### One screen's failure stays on one screen

Every section goes through `section(name, build, fallback)`. If building it
throws, the fault is logged, that screen gets a panel saying it could not be
drawn — naming itself, with the one line worth sending to support and three
ways out — and **every other screen carries on working**. Before this, only
Settings was wrapped; the eleven sections added for payments, receivables and
recurring were not, and any one of them could take the dashboard down.

The fallbacks are generated from what the template actually walks rather than
written from memory: every list it iterates is an empty array, every flag it
tests is false, every handler it binds does nothing. A fallback missing one of
those keys would throw inside the handler for the first throw, and there is no
net under that one.

### The shell is guaranteed before any screen is

`d()` merges the book over `EMPTY_BOOK` so every list is a list. The
navigation, the badges and the period totals are built outside any section —
outside the net — so a server answering `{}` used to take the whole interface
down on `d.tx.filter` before any screen had been reached. A field the server
did not send now reads as empty, which is what "we have not got that" means
on every one of them.

Each screen then treats its own payload as loaded only when it carries what
that screen reads. A half-shaped response falls into the same branch as no
response at all, which every template is already built to draw.

### The server keeps serving

Node ends the process on an unhandled promise rejection. For a library that is
right; for the single process serving a live accounting product it is not. The
realistic source is background work — the billing pass, a backup, the ledger
backfill, a recurring schedule — and a lost promise in a timer should not take
the books offline for every business using them at three in the morning.

So it is logged in full, counted, and the count is on `/api/health` as
`faults`. Zero is the only good answer. Nothing is swallowed: the reason and
the stack go to the log, and a process quietly limping while everyone assumes
it is fine is worse than one that fell over honestly.

### The suite that proves it

`npm run test:screens` — 119 checks in a real browser against a real server.
It does not read the code and agree with it. It **breaks things**:

- every screen in the navigation, and every tab inside Invoicing, is visited
  and must draw with nothing thrown;
- every form is opened;
- then each of nine API calls the screens depend on is replaced, one at a
  time, with each of five things a real deployment has actually produced — an
  empty object, `null`, an array where an object belongs, nulls inside every
  field, and a proxy's HTML error page. Forty-five combinations, and after
  each one both the broken screen and **the dashboard** must still be usable;
- then the API is killed outright and four screens must still draw;
- then one section is fed a payload shaped to pass every guard and throw
  anyway, to watch the net catch something. The screen must say it could not
  be drawn, say *which* screen, keep the navigation, and leave the fault
  behind when you walk away from it.

A contained failure is counted as the system working, not as a crash — that is
the whole point of the guard — but anything uncaught fails the run.

It is the only suite needing a browser, so a machine without one skips loudly
rather than failing. **CI should set `SCREENS_REQUIRE_BROWSER=1`**, which turns
a skip into a failure, so the guarantee cannot quietly stop being checked.

### What it found the first time it ran

- A malformed book payload killed the shell, not just a screen — the fault
  this was all built to prevent, live in the product.
- `st.invList || { invoices: [] }` did not help, because `{}` is truthy: a
  half-shaped payload sailed past the fallback and threw on `.invoices.map`.
- Nine of the eleven new sections had no guard around them at all.

## Recurring invoices

A retainer billed on the 1st of every month is the same invoice twelve times,
and typing it twelve times is twelve chances to type it differently. A
schedule holds the template and the cadence; the generator turns it into real
invoices through **the same code path the builder uses**, so a generated
invoice and a typed one are the same kind of row — same series, same totals,
same ledger entry, same event log.

That shared path is `src/invoicing/issue.js`, and extracting it was the first
thing this release did. Copying forty lines of INSERT into the generator
would have worked on the day it was written and then drifted, the way
`backfill.pending()` drifted when it was written twice.

### Never twice

Duplicate billing is the characteristic failure of recurring invoicing and
the expensive one: a customer billed twice for March assumes the rest of
their account is equally reliable. Three things stop it, in order of how much
work they do:

1. The generator advances the schedule **inside the same transaction** that
   writes the invoice. Nothing can observe a raised invoice without also
   observing the schedule having moved on.
2. `SELECT … FOR UPDATE SKIP LOCKED` on the schedule row, so a second
   container leaves it to the first rather than queueing behind it and
   raising the next occurrence the moment the lock is released.
3. A unique index on `(recurring_invoice_id, recurring_occurrence)`. This is
   the backstop for everything that is not the generator — a retried run, a
   restore replaying a partial transaction log, somebody pressing "Raise now"
   twice. A duplicate-key error on it is caught and treated as success,
   because the invoice exists, which is what was wanted.

The test fires six simultaneous passes at one schedule and asserts that one
invoice comes out, then inserts a duplicate occurrence by hand and asserts the
database refuses it.

### The right date

A monthly schedule anchored on the 31st bills on the 31st of every month that
has one and the last day of every month that does not, **and then goes back to
the 31st**:

    2026-01-31  2026-02-28  2026-03-31  2026-04-30  2026-05-31

Computing it as "add 30 days", or as "clamp and carry the clamp forward",
walks the date backwards a little every year — which nobody notices until a
customer asks why January's invoice arrived on the 26th. So the anchor day is
remembered and each date is computed from it, not from wherever the last
clamp landed.

All of the date arithmetic is string work on `YYYY-MM-DD` plus integers.
Nothing constructs a `Date` and adds milliseconds: a server in Lagos, a server
in UTC and a day on which clocks change must produce the same invoice date.

### Catching up, and not running away

A schedule created with a start date in the past deliberately catches up.
Somebody setting up a retainer that began in June wants June through to now
raised, each dated for its own period — not one invoice dated today covering
five months. The catch-up is capped (36 by default) so a start date mistyped
as 2015 produces a refusal rather than a hundred and thirty invoices.

### Stopping

| How it stops | What happens |
|---|---|
| Reached `max_occurrences` | Marked finished with reason `completed`, in the same transaction as the last invoice |
| Passed `end_date` | Marked finished with reason `ended` |
| Stopped by hand | Marked finished with reason `stopped` |
| Could not raise its invoice | **Paused**, with the reason on the record |

That last row matters. A schedule whose books are closed, whose lines have
been deleted, or whose figures no longer add up stops visibly rather than
failing once an hour into a log nobody reads. The error is on the schedule
card in amber.

Pausing keeps the schedule's position. **Resuming skips the periods it was
paused for** rather than billing them, because raising three invoices for
three months nobody was billed for is almost never what a pause meant;
`catchUp: true` asks for the other behaviour explicitly.

### Where it is stored, and the one stored figure

`next_due` is a stored column, which is against the grain of this schema —
document status, balances, trial ends and ledger figures are all derived at
read time precisely so they cannot go stale. This one is stored on purpose
and the reason is that it is **not derivable**: once a human has paused a
schedule for two months or skipped a cycle, where the schedule stands is a
record of decisions, not arithmetic on the start date. Deriving it would
silently raise the two invoices the pause was meant to prevent.

Line *inputs* are stored, not line totals. The figures are recomputed every
time an invoice is raised, so a business that registers for VAT in October
has VAT on November's invoice and not on September's — which is correct, and
is asserted.

### The scheduler

A timer in the server, hourly, under Postgres advisory lock `4820774`
(billing holds `4820771`, backups `4820772`, the ledger backfill `4820773`).
Hourly rather than daily because a container restarted every afternoon would
otherwise never see midnight. `RECURRING_SCHEDULER=off` stops it;
`POST /recurring-run` and `POST /recurring/:id/run` do a pass on demand.

### Routes

| Route | What it does |
|---|---|
| `GET /recurring` | Every schedule, with what each has billed and what is still owed |
| `GET /recurring/:id` | One schedule, the next six dates it will raise, and every invoice it has raised |
| `POST /recurring` · `PUT /recurring/:id` | Create and edit. The start date stops moving once it has raised something |
| `POST /recurring/:id/pause` · `/resume` · `/skip` · `/stop` | The four controls |
| `POST /recurring/:id/run` | Raise what that schedule owes, now |
| `POST /recurring-run` | Raise what every schedule on these books owes |
| `DELETE /recurring/:id` | Admin only. The schedule goes; the invoices it raised stay |

`npm run test:recurring` — 50 checks.

### A fault it found in older code

**Invoice numbers collided across years.** `document_sequences` held one
counter per (organisation, kind) plus the year it was last used in, and
allocating for a different year reset the counter to 1 — correct on the 1st of
January and wrong every other way it happens. Enter a late December invoice
and the next one dated this year is handed a number that already exists; the
unique index turns that into an error, so nothing was ever mis-numbered, but
the business simply cannot issue an invoice until somebody works out why.

A recurring schedule backdated across a year boundary does this several times
in a row, which is how it surfaced. Migration 015 gives each year its own
counter and seeds the years that already have documents from the trailing
digits of their numbers, so allocating for 2025 cannot disturb 2026.

## Payments and receivables

Release 2 of Smart Invoicing: taking money in, deciding what it paid for, and
giving some of it back.

### The architecture, and why it is the architecture

**Profitna is the accounting platform, not the intermediary.** A tenant's
customer pays that tenant's own merchant account. Nothing a customer pays
passes through Profitna's balance, Profitna never holds it, and the
credentials that make that true are stored per organisation.

This is not a preference. `src/integrations/paystack.js` and
`src/integrations/monnify.js` read `PAYSTACK_SECRET_KEY`, `MONNIFY_API_KEY`
and the rest from the environment, and they collect **Profitna's own
subscription fees** into Profitna's own account. `src/payments/providers.js`
reads no environment variable at all: every call takes credentials it is
given, and those come from the organisation whose invoice is being paid.
There is no code path by which a tenant's customer payment could be initiated
against Profitna's keys, because those keys are not reachable from there.

### One receipt, many allocations

Before this release Profitna could record "a payment of ₦120,000 against
invoice 7" and nothing else. A customer who sends ₦500,000 covering four
invoices and a deposit on a fifth had to be typed in as five payments that
never happened.

So: `customer_payments` is the money — a date, a method, a bank account, a
receipt number the customer can be given. `invoice_payments` rows are the
allocations, and they gain a parent rather than being replaced; every row that
existed before still means exactly what it meant. The allocations do not have
to add up to the receipt, and the part that does not is **money received in
advance** — a liability, not revenue and not a settled receivable.

| What happened | What posts |
|---|---|
| Receipt, fully allocated | Dr Bank · Cr Accounts Receivable |
| Receipt, partly allocated | Dr Bank · Cr Receivable (allocated) · Cr Customer Deposits (the rest) |
| Allocating that remainder later | Dr Customer Deposits · Cr Receivable |
| Paid through a gateway | Dr Gateway Clearing · Cr Receivable / Customer Deposits |
| That payment settling | Dr Bank (net) · Dr Gateway Fees · Cr Gateway Clearing |
| Credit note issued | Dr Revenue · Dr Output VAT · Cr Receivable |
| Credit note applied to an invoice | **nothing** |

That last row is the one worth dwelling on. Issuing a credit note credits the
receivable immediately; which invoice it is set against is a fact about the
receivables subledger, not about the general ledger. Posting it again on
application would credit the receivable twice — and the trial balance would
still balance.

A receipt also writes one cash-book row, so a bank statement can be matched to
it. A gateway payment that has not settled deliberately carries no bank
account: the money is with the processor, and showing it on the bank would
make every reconciliation fail by the amount in transit, every day, until
somebody worked out why.

### A redirect is not a payment

Every path that could create a gateway receipt ends in a call to the
provider's own verify endpoint with the tenant's own secret key, and only that
call writes a receipt. A customer arriving back with `?status=success` on the
URL has told us nothing — they may have pressed back, they may have edited the
address bar, the gateway may have redirected before the card settled.

The amount recorded is the amount the provider says arrived, never the amount
we asked for. A customer who paid less has paid less, and writing down what we
wanted would settle an invoice that is still owed.

The same payment may be reported many times — a retried webhook, a refreshed
return page, somebody pressing "Check if it is paid". All of them collapse
onto one receipt, because the provider's reference is unique per organisation
in the database and the recorder returns the existing row rather than writing
a second one.

### Webhooks

Each organisation gets its own webhook path containing a 256-bit token:

    https://profitna.com/api/pay/hook/<token>

The order is not negotiable: find the account from the token in the path,
check the HMAC with that account's secret, and only then read the body.
Reading an organisation id out of an unauthenticated payload and then
verifying against *that* organisation's key would let anybody with a webhook
URL choose which tenant's secret their forgery is checked against.

An unknown token is a plain 404. A bad signature is a 401 and nothing from the
body is recorded. A signed event about a payment Profitna did not issue is
accepted and ignored, so the provider stops retrying it.

### Credentials

A merchant secret key is the one thing in this database worth stealing on its
own. It is encrypted with AES-256-GCM under `CREDENTIALS_KEY`, which lives in
the environment and never in the database, so a stolen dump yields ciphertext.

The organisation id and provider are the **additional authenticated data**, so
a ciphertext copied out of one organisation's row into another's fails to
decrypt rather than yielding a live key — tenant isolation the database alone
cannot give, because the database is what leaks.

Without `CREDENTIALS_KEY` the module refuses to encrypt rather than falling
back to plaintext. A feature that is clearly switched off is recoverable; a
secret key sitting in a text column because the fallback seemed friendlier is
not.

**Without the key the whole surface is hidden rather than disabled.** The
Settings panel does not render and no invoice offers a Pay-link button. It
used to render greyed out with an amber box naming `CREDENTIALS_KEY`, which
is the right message for whoever runs the server and the wrong one for every
customer admin who opens Settings: it is not their server, they cannot set
it, and a panel whose every field is dead reads as something broken rather
than something not switched on yet. The operator keeps both signals that are
actually theirs — the boot warning and `merchantCredentials` in
`/api/health` — and the panel comes back by itself the moment the variable is
set. Nothing in the code has to change to bring it back.

The gate has two stages, so a button never appears before it would work:

| State | Settings panel | Pay-link button on an invoice |
|---|---|---|
| No `CREDENTIALS_KEY` | hidden | hidden |
| Key set, no account connected | **shown**, so a tenant can connect one | hidden |
| Account connected and proved | shown | **shown** |

Recording a payment by hand is never gated on any of this. It is money that
has already arrived, and the books do not care how it was established.

No endpoint returns a secret. `GET /payment-accounts` returns a mask —
`sk_test_••••••••9f2c` — which is enough to tell a wrong paste from a right
one and not enough to use. Sending that mask back does not overwrite the
stored key.

Nothing is active until the provider itself has accepted the credentials.
Saving sets `active = false`; only a successful test flips it, and changing a
key un-proves it. An invoice does not offer a Pay button on the strength of
somebody having typed something into a form.

### What the database guarantees

Two deferred constraint triggers, because the code is not the only thing that
will ever write to these tables and over-allocating money is the kind of
mistake discovered months later by a customer:

- allocations may not exceed the payment they belong to;
- credit note applications may not exceed the note.

Migration 012 adds a third guarantee of the older kind: `invoice_payments`
gains an integer-kobo column and a tenant, both filled by a BEFORE trigger so
every write path gets them whether or not it remembers, and both then made
`NOT NULL`. `amount` in naira is kept in step beside it, so every query and
screen that already read it still works.

### Routes

| Route | What it does |
|---|---|
| `GET /payments/new` | Everything the form needs in one call: open invoices, bank accounts, customers, whether online collection is available |
| `GET /payments/suggest` | Oldest-first allocation, as a suggestion |
| `POST /payments` | Record a receipt with its allocations |
| `POST /payments/:id/allocate` | Put money already received against invoices |
| `POST /payments/:id/settle` | A gateway payment reaching the bank, with the fee |
| `POST /payments/:id/reverse` | Admin only. A reversal, never a delete |
| `POST /credit-notes` | Issue one, applied to the invoice it names |
| `POST /credit-notes/:id/apply` | Set credit against another invoice |
| `POST /credit-notes/:id/void` | Admin only. Reverses and reopens |
| `POST /invoices/:id/payment-link` | A hosted checkout on the tenant's own account |
| `POST /payment-links/:reference/check` | Ask the provider again, now |
| `GET /receivables` | The whole screen: ageing, who owes what, money on account, unapplied credit |
| `PUT /payment-accounts/:provider` | Save credentials. Admin only |
| `POST /payment-accounts/:provider/test` | Prove them against the provider |
| `POST /api/pay/hook/:token` | Public. One tenant's gateway posting an event |
| `GET /api/pay/return/:reference` | Public. Where the customer lands, which verifies before it says anything |

`npm run test:payments` — 151 checks against a real database and a fake
Paystack and Monnify, because the questions worth asking are what happens when
a provider says "pending", reports a smaller amount than we asked for, replays
a webhook, or has its signature forged, and none of those can be arranged
against a real gateway.

### Two faults this release found in older code

**The ledger's "post now" skipped direct payments.** `backfill.pending()` had
its predicate written twice — once for the whole database and once for a
single organisation — and the two had drifted. The single-organisation branch
had no clause for payments recorded straight onto a document, so the Control
Center reported an organisation as complete while its receivable was still
overstated by every payment with no cash-book row behind it. The predicate is
now written once.

**A test suite failing a different test suite.** `test/trial.js` created
organisations and never deleted them. Twenty-six paid subscriptions with no
card on file accumulated across runs, which pushed `test/billing.js`'s own row
off the end of a capped list and failed an assertion nothing had touched. The
list's cap was also raised and its total is now reported, because a Control
Center card showing twenty-five of forty rows with nothing saying so will be
read as "twenty-five".

### Not in this release

Nigeria Revenue Service e-invoicing is not implemented and nothing in the
product claims an invoice has been transmitted to or verified by it. Refunds
back to a card are not implemented either: a credit note handles the
accounting, and a refund paid out is recorded in the cash book like any other
payment.

## Invoice PDFs

Rendered server-side with **@react-pdf/renderer**, in `src/invoicing/pdf.js`.
It was the preferred option and it survived the evaluation, on three counts
that were checked rather than assumed:

- **Pure JavaScript.** No Chromium, no native module, nothing to compile
  against musl — so the Alpine image stays small and a deploy cannot fail on
  a binary that will not build. `find node_modules -name '*.node'` comes back
  empty.
- **Loads from CommonJS with no build step.** This codebase has no bundler and
  adding one for a PDF would be the tail wagging the dog, so every element is
  `React.createElement` rather than JSX.
- **It paginates.** Sixty lines become three A4 pages with the table header
  repeated and "Page 2 of 3" in the footer, which is the part that separates a
  document from an HTML print view.

The alternative, had it failed, was **pdfkit** — which is what react-pdf uses
underneath, equally free of native dependencies, at the cost of writing the
layout by hand.

### Two things that were nearly shipped broken

**The naira sign.** The fourteen built-in PDF fonts use WinAnsi encoding,
which has no ₦ (U+20A6). Rendered with Helvetica it silently becomes `0xA6` —
a broken bar — and every amount on every invoice reads `¦107,500.00`. Nothing
errors. DejaVu Sans is therefore bundled in `assets/fonts` and embedded in
each document, and the test asserts `/FontFile2` is present, that U+20A6
appears in the ToUnicode map, and that the extracted text contains ₦ and not
¦. Any font swapped in later must contain that glyph.

**A `lineHeight` reaching the footer.** A unitless `lineHeight` anywhere in
the subtree of an absolutely positioned `fixed` block makes react-pdf lay that
block out to nothing. The footer stayed in the element tree and was never
drawn: no page numbers, no attribution, no error. Line spacing is now set only
on text blocks that are not inside it, and the test reads the footer back out
of the rendered PDF rather than trusting the element tree.

The lesson both share: a PDF test that checks the file is non-empty passes
happily while the document is wrong. These are read back the way a customer's
PDF viewer reads them, with `pdf-parse`.

### Designs

Five themes in `src/invoicing/themes.js` — Executive Minimal, Modern FinTech,
Professional Classic, Creative Studio, Luxury Business — as one layout
parameterised by colour, header treatment, table ruling and typographic scale,
rather than five copies of the same file where the fourth always misses a fix.
A business may override the accent colour; the value is validated as a hex
colour because it goes straight into the document.

Deliberately not black and gold: that is the app's identity, and an invoice
should look like the customer's business rather than like ours. Every document
carries one small "Powered by Profitna" in the footer.

    GET  /api/orgs/:id/invoices/:invoiceId/pdf        inline, add ?download=1
    POST /api/orgs/:id/invoices/preview               totals without rendering
    GET  /api/orgs/:id/invoice-templates              the five designs

`npm run test:pdf` — 52 checks, including that one organisation's invoice id
cannot be fetched under another's books, and that an invoice written before
line items existed still renders.

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
