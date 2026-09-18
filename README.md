# Profitna

**Know Your Numbers. Grow Your Business.**

Accounting and business finance for Nigerian businesses — SMEs, companies,
churches and non-profits. Invoicing and receivables, bills and payables, a cash
ledger, inventory, bank reconciliation with statement import, and financial
reports prepared on a cash basis in ₦, with VAT and deductibility handled the
way Nigerian tax rules expect.

Two sets of books are supported and chosen at signup: **SME / business /
company**, and **church / non-profit**, which swaps invoices for pledges and
adds fund accounting by designation.

## Stack

| Layer | What it is |
|---|---|
| Front end | HTML, CSS and JavaScript, rendered through React — one page, no build step |
| Back end | Node.js + Express |
| Database | PostgreSQL |
| Deployment | Docker, with Caddy or a control panel terminating TLS |

## Layout

```
web/            The application interface
  Profitna.dc.html    every screen, the design system, and the API client
  support.js          the rendering runtime
  vendor/             React and the spreadsheet reader, served locally

server/         The API and the database
  src/routes/         auth, ledger, bank, org, subscription
  src/sql/            schema migrations
  src/integrations/   Paystack, Google, Anthropic
  test/smoke.js       end-to-end checks against a running server

deploy/         Bootstrap script and Caddy config
docs/design/    How the product was designed: transcripts, the original
                build spec, and the schema it was derived from
```

Root holds the deployment files: `Dockerfile`, the two compose files, and
`render.yaml`.

## Running it locally

Needs Node 22 and PostgreSQL 16.

```bash
createdb profitna
cd server
cp .env.example .env          # set JWT_SECRET
npm install
npm run migrate
SEED_DEMO_DATA=true npm start # http://localhost:4000
```

`SEED_DEMO_DATA=true` fills each new account with eight months of sample
Nigerian books, which is what you want for development. Leave it unset in
production so real accounts start empty and meet the designed empty states.

With the server running, `npm run smoke` exercises signup, the ledger,
invoices and payments, inventory, statement import, subscriptions, and
confirms one organisation cannot read another's books.

## Deploying

See **[DEPLOY.md](DEPLOY.md)** — covers a VPS (including one already running
CloudPanel or another control panel) and Render.

Configuration is documented in **[server/README.md](server/README.md)**. Every
optional integration stays off until its key is set, and the app degrades to
something honest rather than pretending:

| Unset | Effect |
|---|---|
| `GOOGLE_CLIENT_ID` | Google sign-in reports it is not configured |
| `PAYSTACK_SECRET_KEY` | Cards are recorded for display only; nothing is charged |
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher |
| `MONO_SECRET_KEY` | Bank feeds unavailable; CSV/Excel import unaffected |

## Status

Working end to end: accounts and sessions, both sets of books, the cash ledger,
invoices and pledges, bills, payments, contacts, inventory with stock moves,
statement import and reconciliation, the chart of accounts with per-account
deductibility, reports, and subscription state. Data is scoped per
organisation, and that scoping is enforced in one place in the API rather than
sprinkled through it.

Not finished yet:

- Nothing charges the card when a trial ends — `chargeDue()` exists but needs a
  scheduler calling it.
- Mono's bank-connect widget is not in the front end; the exchange, webhook and
  storage are ready behind it.
- WhatsApp and email delivery are interface only, and say so in the product.
- Roles (admin / accountant / viewer) are enforced by the API, but the
  interface does not yet hide what a viewer cannot do, and there is no invite
  flow — treat every account as an owner for now.
