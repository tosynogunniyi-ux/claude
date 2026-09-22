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
| `PAYSTACK_SECRET_KEY` + `PAYSTACK_PUBLIC_KEY` | Signup falls back to its own card form and records the card for display only; nothing is charged. |
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher, which still codes most Nigerian bank narrations. |
| `MONO_SECRET_KEY` | Bank feeds are unavailable; the CSV / Excel / Sheets import path is unaffected. |
| `ADMIN_PATH` | The owner's console is served at `/admin`. |
| `ADMIN_IP_ALLOWLIST` | The console is reachable from any address. |
| `ADMIN_TOTP` | Two-factor is required. Set it to `off` only if you cannot use an authenticator app. |

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
- Successful and failed charges are written to `payments`, from signup, from
  `chargeDue()` and from the Paystack webhook, keyed on the provider reference
  so a retried webhook does not duplicate a line.
- `expired` is **derived** from the period end and today's date, never stored —
  the same rule invoices follow. `suspended` is stored, because it is an act
  rather than a consequence.

## Payment card handling

The card number and CVV never reach this server, on either path.

With Paystack configured, signup hides its own card fields and opens Paystack
Inline: the customer types the card into Paystack's window, a small
verification amount (`PAYSTACK_VERIFY_AMOUNT`, default ₦50) authorises it, and
the browser sends back only a transaction reference. The server verifies that
reference against Paystack, and takes the brand, last four and expiry from the
verification rather than trusting the client. A signup that arrives without a
reference is refused while a processor is configured, so the card form cannot
be used to bypass payment.

Without Paystack, the form validates locally and sends only the brand, last
four and expiry — what the UI displays back.

The reusable authorisation code is what `chargeDue()` charges when a trial
ends or a term renews. Wire that to a scheduler when you go live, and point
the Paystack webhook at `/api/webhooks/paystack`.

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

- Charging at trial end needs a scheduler calling `chargeDue()`.
- Mono's Connect widget needs adding to the front end; the exchange, webhook
  and storage are in place behind `MONO_SECRET_KEY`.
- WhatsApp and email delivery are UI-only, as the design intends — no
  integration claims are made anywhere in the product.
- Roles are enforced on the API (`admin` / `accountant` / `viewer`), but the
  UI does not yet hide what a viewer cannot do, and there is no invite flow.
- Control Center accounts are created at the command line only — there is no
  invite flow and no "add another owner" screen, on purpose. A console that
  can mint its own administrators is a console one stolen session can keep.
