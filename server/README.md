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
tenant isolation.

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
| `PAYSTACK_SECRET_KEY` | Cards are recorded for display only; nothing is charged at trial end. |
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher, which still codes most Nigerian bank narrations. |
| `MONO_SECRET_KEY` | Bank feeds are unavailable; the CSV / Excel / Sheets import path is unaffected. |

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

Two rules the schema enforces by design, carried over from the build spec:
document status is **derived** from payments and due date rather than stored,
and a contact's name is **snapshotted** onto invoices and bills so renaming or
deleting a contact never rewrites history.

## Payment card handling

The card number and CVV never reach this server. The signup form validates
them in the browser and sends only the brand, last four digits and expiry —
what the UI displays back. With `PAYSTACK_SECRET_KEY` set, the browser charges
through Paystack's SDK first and passes the transaction reference here, which
is verified server-side; the reusable authorisation code it returns is what
`chargeDue()` charges when a trial ends or a term renews. Wire that to a
scheduler when you go live.

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
