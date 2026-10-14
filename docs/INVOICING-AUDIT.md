# Smart Invoicing 2.0 — Phase 0 audit

What Profitna actually has today, what the specification assumes it has, and
where those two differ. Written against the code at the commit that added it,
not from memory.

---

## 1. What exists and will be reused

| Concept in the spec | What it already is here | Verdict |
|---|---|---|
| Customers | `clients` table (id, org, name, email, phone, address, notes) | **Reuse.** No parallel table. |
| Suppliers | `vendors` | Reuse |
| Products and services | `inventory_items` (name, sku, kind, cost, price, qty, reorder) | **Reuse.** Already distinguishes `product` / `service`. |
| Invoices | `invoices` (one row, one `total`) + `invoice_payments` | **Extend.** See §2. |
| Bills | `bills` + `bill_payments` | Untouched by this work |
| Cash ledger | `transactions` — single entry, income/expense, cash basis | See §3 |
| Bank accounts | `bank_accounts` with opening balances and derived balances | Reuse |
| Company settings | `organizations` + logo bytes | **Extend.** See §2. |
| Roles | `memberships.role` — `admin` / `accountant` / `viewer`, ranked | Reuse. Maps onto the spec's Owner / Accountant / Viewer. |
| Tenant isolation | `requireOrg()` — the single choke point; a foreign org is a 404, not a 403 | Reuse. Already smoke-tested. |
| Audit trail | `audit_log` (org, user, action, entity, detail, time) | Reuse |
| Background jobs | `billing.js` and `backup.js`: `setInterval` + a Postgres advisory lock per pass, self-healing on restart | **Reuse the pattern** for recurring invoices |
| Payment processors | `integrations/{monnify,paystack}.js` behind `gateway.js`, one shape | Reuse the adapter shape — but see §4 |

Document status is already **derived, not stored** — from payments and due
date, read fresh. That rule holds across the product and this work keeps it.

---

## 2. What is missing and must be built

**Invoices have no line items.** An invoice today is a header with a single
`total` typed by the user. Phase 2's item grid, per-line tax, per-line
discount, units of measure and quantities have nowhere to live.

**No company identity for a document.** `organizations` holds name, book type,
business type, state, VAT rate and a logo. It has **no address, phone, email,
website, TIN or RC number** — six of the fields Phase 2 says must appear on
every invoice without being retyped.

**No tax engine.** There is one `organizations.vat_rate` and a
`deductible_pct` on expense categories. No tax rules, no per-item
classification, no zero-rated or exempt handling, no effective dates, no
withholding tax.

**No quotations.** No table, no routes, no screens.

**Invoice numbering races.** `UNIQUE (organization_id, number)` exists, which
is why a clash is a clean 409 today. But `nextNumber()` reads the highest and
then inserts — two simultaneous invoices read the same highest. The constraint
turns that into an error rather than a duplicate, which is safe but not
correct behaviour under concurrency.

**No email delivery of any kind.** This is deliberate and stated throughout
the product: invitations produce a link to copy, and nothing claims to send
mail. Phase 5 needs a provider, a verified sending domain, SPF/DKIM, and
bounce handling.

**No PDF generation.** Reports print through the browser. Phase 3's
server-generated A4 PDFs need a renderer in the image.

**No customer-facing surface.** The product is one authenticated page. The
Phase 10 portal is a second surface with its own authentication model.

---

## 3. The decision this specification cannot avoid

Phase 12 asks for accrual journal entries:

    Dr Accounts Receivable   107,500
      Cr Service Revenue              100,000
      Cr Output VAT Payable             7,500

and says "reuse Profitna's existing chart-of-accounts, journal and ledger
tables" and "never create a disconnected financial ledger".

**Those tables do not exist.** There is no chart of accounts, no journal, no
double-entry engine, and every existing report — P&L, VAT, the dashboard, the
cash-flow forecast — is computed from the single-entry cash ledger.

So Phase 12 is not an integration. It is building a general ledger and then
migrating the product's entire reporting layer onto it. That is a larger piece
of work than the rest of Release 1 put together, and it changes numbers that
customers are already looking at.

There are two honest routes:

**A. Stay cash-basis (smaller, consistent with the product today).**
An issued invoice is a receivable, not revenue. Revenue is recognised when
cash arrives, exactly as now. Invoices and receivables reporting are exact;
the P&L keeps meaning what it means today. VAT is reported on payment, which
is in fact what Nigerian VAT filing works on for many small businesses.
No existing figure changes.

**B. Build the general ledger (what Phase 12 literally asks for).**
New `accounts`, `journal_entries`, `journal_lines` tables; every existing
cash transaction back-posted into it; P&L, balance sheet and VAT reports
rewritten to read from the GL; accrual and cash basis both offered. This is
the right end state for a serious accounting product, and it is a project of
its own with real risk to figures already in use.

**Decided: B, accrual.** The ledger is built — `accounts`,
`journal_entries`, `journal_lines`, a posting engine, and a backfill that put
every existing invoice, bill, payment and cash-book row into it. The cash book
is untouched and every existing report still reads it, so no figure a customer
was already looking at has changed. Accrual reports are new endpoints
alongside them. See `server/README.md` → The general ledger.

---

## 4. Two kinds of money, which must never mix

The spec flags this and it is worth being explicit, because the code currently
only does one of them.

**Profitna's own subscription billing** — what a business pays Profitna. Live
through Monnify, keys in `MONNIFY_*` environment variables, one merchant
account: Profitna's.

**A tenant's invoice collection** — what *their* customer pays *them*. This
does not exist yet, and it cannot reuse those credentials: that would route a
customer's payment into Profitna's own account.

Phase 6 therefore needs per-organisation merchant credentials, stored
encrypted and scoped to the tenant, with the adapter shape reused but the
secrets resolved per request rather than from the environment. That is a new
piece of infrastructure, not a flag on the existing one.

---

## 5. Order of work

Unchanged from the spec's own Release plan, with the foundation split out
because everything else sits on it:

1. **Foundation** — line items, numbering, money arithmetic, tax engine,
   company identity, PDFs, and the general ledger. *(Done.)*
2. **Release 1 rest** — builder UI, PDF, draft/issue lifecycle, dashboard.
3. **Release 2** — payments, per-tenant gateways, allocations, receipts,
   credit notes.
4. **Release 3** — email, portal, reminders, recurring, quotations.
5. **Release 4** — AI drafting, insights, e-invoicing, reconciliation.

---

## 6. Outstanding before later phases can be finished

| Needed | For | Status |
|---|---|---|
| Accrual-vs-cash decision (§3) | Phase 12 | **Decided: accrual. Ledger built.** |
| Email provider + verified domain | Phase 5 | Not started |
| Per-tenant gateway credentials | Phase 6 | Design in §4 |
| WhatsApp Business Platform account | Phase 5 | Not started |
| NRS access point and credentials | Phase 13 | Not started; adapter to ship inactive and clearly labelled |
| `ANTHROPIC_API_KEY` | Phase 14 | Already wired for Ask Profitna; unset on live |
