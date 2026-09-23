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
  admin.html          the platform owner's Control Center
  vendor/             React and the spreadsheet reader, served locally

server/         The API and the database
  src/routes/         auth, ledger, bank, org, subscription, members, admin
  src/sql/            schema migrations
  src/integrations/   Paystack, Google, Anthropic
  src/create-admin.js the only way a Control Center account is created
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
confirms one organisation cannot read another's books. `npm run smoke:admin`
does the same for the Control Center, and `npm run test:billing` drives a
trial through to a charge, a decline, a retry and a recovery.

## Signing up

    sign up  →  no card  →  14-day trial  →  trial ends  →  pay  →  active

Creating an account asks for a name, an organisation, an email, a password and
a plan — and nothing to pay with. No debit card, no ATM card, no credit card.
The account opens straight onto a 14-day trial, and the app shows how many
days are left.

When the trial runs out the books close behind a payment screen rather than
disappearing: **nothing is deleted**. The organisation, the ledger, the
invoices and every figure entered stay exactly where they were, and come back
the moment payment goes through. A failed payment leaves the customer on that
screen, free to try again.

## Roles and the team

One seat means one person, and that person is the admin of their own books.
Buy more and the extra seats are named at signup, each with a role:

| Role | May |
|---|---|
| **Admin** | Everything: books, settings, team and billing. |
| **Accountant** | Enter and edit transactions, invoices, bills and reports. |
| **Viewer** | Read the dashboard and reports. Nothing else. |

An active subscriber can add, re-role or remove people at any time from
**Settings → Team & access**, within the seats they pay for.

There is no email delivery in this product and none is pretended: inviting
somebody produces a link to copy and send. It lets them set their own
password and join with the role they were given, and it works once. An
organisation always keeps at least one admin.

## The Control Center

The platform owner's console — every registered account, what each is paying,
when it renews or expires, what has happened on it, and the controls to
suspend, deactivate or reinstate an account.

It is a separate application behind separate credentials: its own table, its
own cookie, its own sessions, and a required second factor. A customer's
`admin` role is admin of one set of books and can never reach it.

There is no default account and no route that creates one. Until you run

```bash
cd server && npm run create-admin -- --email you@example.com --name "Your Name"
```

`/admin` answers 404 to everyone. See
**[server/README.md](server/README.md#the-control-center)** for the rest.

## Deploying

See **[DEPLOY.md](DEPLOY.md)** — covers a VPS (including one already running
CloudPanel or another control panel) and Render.

Configuration is documented in **[server/README.md](server/README.md)**. Every
optional integration stays off until its key is set, and the app degrades to
something honest rather than pretending:

| Unset | Effect |
|---|---|
| `GOOGLE_CLIENT_ID` | Google sign-in reports it is not configured |
| `PAYSTACK_SECRET_KEY` | Trials run, but an expired account cannot be paid for from the app |
| `ANTHROPIC_API_KEY` | Category suggestions fall back to the keyword matcher |
| `MONO_SECRET_KEY` | Bank feeds unavailable; CSV/Excel import unaffected |
| No owner account | The Control Center at `/admin` answers 404 |

## Status

Working end to end: accounts and sessions, both sets of books, the cash ledger,
invoices and pledges, bills, payments, contacts, inventory with stock moves,
statement import and reconciliation, the chart of accounts with per-account
deductibility, reports, and subscription state. Data is scoped per
organisation, and that scoping is enforced in one place in the API rather than
sprinkled through it. Several people can share one set of books, each with a
role. The owner's Control Center is live behind its own credentials and second
factor.

Not finished yet:

- Mono's bank-connect widget is not in the front end; the exchange, webhook and
  storage are ready behind it.
- WhatsApp and email delivery are interface only, and say so in the product.
- Roles are enforced by the API and assignable in the product, but the
  interface does not yet grey out what a viewer cannot do — they see the
  buttons and are told no when they use one.
