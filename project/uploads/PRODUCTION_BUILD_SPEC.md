# Business Finance Manager — Production Build Specification

**Purpose of this document:** hand this (and `schema.sql`) to Claude Code to scaffold and build the real, multi-user, database-backed, bank-connected version of the prototype delivered earlier in this chat. I can't run Claude Code from inside this conversation — it's a separate app (desktop app's Code tab, CLI, or VS Code/JetBrains extension) — so this document is written to be a complete, self-contained brief for that session.

---

## 1. What changes from the prototype

The prototype (`business-finance-manager.jsx`) is a single-user, browser-side artifact: all data lives in one private key-value store, there's no login, and the "AI categorize" button calls Claude directly from the browser. It proved out every screen and every calculation. The production build keeps the *same* data model, screens, and business logic, and adds the four things a browser artifact structurally cannot do:

1. **Real accounts** — multiple people (Admin / Accountant / Viewer, per the original brief) signing into the *same* organization's books.
2. **A real database** — Postgres, not a per-user blob, so data can be queried, backed up, and reported on properly.
3. **Live bank feeds** — pulling actual transactions from a Nigerian bank account instead of manual entry or CSV upload.
4. **Server-side AI calls** — the category-suggestion feature moves behind an API endpoint so no API key sits in browser code.

Everything else — the eight modules, the tax-deductibility logic from your TAX RULES sheet, the cash-basis ledger design, the PIT/CIT branching — carries over unchanged.

## 2. Recommended architecture

Two viable paths. **A is the recommendation** given this is a small team building and maintaining its own tool, not a large engineering org — it removes almost all of the undifferentiated backend work (auth, permissions, hosting a database) so effort goes into the actual accounting logic.

### Option A — Recommended: Supabase + Next.js
- **Database + Auth + Permissions:** [Supabase](https://supabase.com) — managed Postgres with built-in authentication and **Row Level Security**, so "only see your own organization's data" is enforced *in the database*, not just in application code. `schema.sql` already includes the RLS policy block for this (commented out — uncomment once the Supabase project exists).
- **Frontend/API:** Next.js (React — your prototype's components port over directly), deployed on Vercel. API routes live alongside the frontend rather than as a separate service.
- **AI categorization:** a Next.js API route that holds the Anthropic API key server-side and proxies the same prompt the prototype already uses.
- **Why this over the original brief's Django/NestJS + raw AWS:** materially less infrastructure to build and operate — no separate auth service, no manually-written permission checks on every query, no server to patch. The tradeoff is less flexibility if you outgrow Postgres/Supabase's model, which is unlikely at SME scale.

### Option B — Custom backend, matching the original brief literally
- **Backend:** Node.js/Express or Python/Django REST Framework.
- **Database:** PostgreSQL (self-hosted or managed — Railway/Render are simpler than raw AWS RDS for a first deploy).
- **Auth:** hand-rolled JWT or a library like Passport/Django-allauth; permissions enforced in each API handler.
- **Frontend:** the existing React components, served separately or via the same framework's static hosting.

`schema.sql` works unchanged under either option — Option B just skips the RLS policies and enforces the same `organization_id` scoping in application code instead.

## 3. Multi-tenancy & roles

- `organizations` = one business (what the prototype currently treats as "the account").
- `users` + `memberships` = people, and their role *within* a given organization (`admin` / `accountant` / `viewer`, matching the original brief's role-based access requirement). One person can belong to more than one organization — useful if Mideops ever manages books for more than one entity.
- Every other table carries `organization_id` and is scoped to it, either via RLS (Option A) or an explicit `WHERE organization_id = :current_org` in every query (Option B) — there is no third way; a missed scope check is a data leak between tenants.

## 4. Database schema

See `schema.sql` — **already written and verified against a live PostgreSQL 16 instance** (ran clean with zero errors; cascade behavior and the derived-status logic below were seeded and query-tested, not just eyeballed).

A few decisions worth knowing before Claude Code starts writing API code against it:

- **Invoice/bill status is derived, not stored.** Only `base_status` (`draft`/`sent`) is a real column. "Paid", "Partially Paid", and "Overdue" are computed from `payments` + `due_date` at query time — exactly like the prototype's `invoiceStatus()`/`billStatus()` JS functions. Storing a computed status as its own column is how these numbers quietly drift out of sync; don't add one.
- **Client/vendor names are snapshotted onto invoices/bills** (`client_name`, `vendor_name` columns alongside the nullable FK). Renaming or deleting a contact must never rewrite historical documents — this was tested above by deleting a client and confirming its invoice survived with the name intact.
- **Deleting an invoice/bill cascades to its line items and payments, but never to the linked cash-ledger transaction** — the transaction's `ref_invoice_id` just goes to `NULL`. Money that moved is a fact; it shouldn't disappear because a document record was removed later. This was also seeded and verified above.
- **`audit_log`** is new versus the prototype — worth populating from day one once more than one person can log in, even if nothing reads it yet initially.

## 5. Bank feed integration

**Use [Mono](https://mono.co)** (now part of Flutterwave, following its 2026 acquisition) for Nigerian account connection and transaction sync. Do **not** integrate Okra — it shut down and refunded investors in 2025 and no longer operates. Stitch is still active but has moved further toward payments infrastructure than pure account/transaction data, so Mono remains the closer fit for "pull an account's transaction history for reconciliation," which is exactly the `bank_transactions` table and Reconcile screen this schema and the prototype already anticipate.

Integration shape:
1. User clicks "Connect a bank account" → your backend requests a Mono Connect session → the Mono widget handles the customer's bank login/consent entirely on Mono's side (your app never touches bank credentials).
2. Mono returns an account id → store it in `bank_connections`.
3. Mono syncs transactions to your backend via webhook (or on-demand pull, depending on their current API tier) → upsert into `bank_transactions`.
4. The existing Reconcile screen's auto-match logic (amount + date proximity) runs against `bank_transactions` instead of an uploaded CSV — same matching algorithm, just a different data source. The CSV-upload path is worth keeping as a fallback for accounts that aren't connected.

Confirm current API scope/pricing directly with Mono when you get to this phase — worth double-checking before building against it, since fintech API offerings shift.

## 6. API contract (REST, one JSON body in/out per route)

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup` · `POST /auth/login` · `POST /orgs/:id/invite` |
| Organization | `GET/PATCH /orgs/:id` (opening balances, tax profile) |
| Categories | `GET/POST /orgs/:id/income-categories` · `GET/POST/PATCH /orgs/:id/expense-categories` |
| Contacts | `GET/POST/PATCH/DELETE /orgs/:id/clients[/:clientId]` · same for `/vendors` |
| Transactions | `GET/POST/PATCH/DELETE /orgs/:id/transactions[/:txId]` · `POST /orgs/:id/transactions/suggest-category` (server-side Claude call) |
| Invoices | `GET/POST /orgs/:id/invoices` · `GET/PATCH/DELETE /orgs/:id/invoices/:invoiceId` · `POST .../payments` · `DELETE .../payments/:paymentId` |
| Bills | Mirrors Invoices |
| Inventory | `GET/POST/PATCH/DELETE /orgs/:id/inventory[/:itemId]` · `POST .../purchase` · `POST .../sale` |
| Loans | `GET/POST/PATCH/DELETE /orgs/:id/loans[/:loanId]` |
| Bank feeds | `POST /orgs/:id/bank/connect` · `POST /orgs/:id/bank/webhook` (public, signature-verified) · `GET /orgs/:id/bank/transactions?unmatched=true` · `POST .../transactions/:btxId/match` |
| Reports | `GET /orgs/:id/reports/{dashboard,pl,cashflow,balance-sheet,tax-summary}` with `start`/`end`/`asOf` query params |

## 7. Migrating data out of the prototype

Every list screen in the prototype (Transactions, Reports) already has an **Export CSV** button (copies to clipboard). For a one-time migration: export each, paste into a spreadsheet, and write a short one-off import script against the API — there's little value in a fancier path for what will likely be a small amount of real data at this stage.

## 8. Suggested build order

Realistic phasing for Claude Code to work through — each phase should be a working, testable state, not a partial one:

1. **Foundation** — schema + migrations, auth, organizations/memberships, category seeding.
2. **Core ledger** — Transactions, Contacts, Dashboard.
3. **Billing** — Invoices, Bills, aging reports.
4. **Inventory + Reports** — Products/Services, P&L, Cash Flow, Balance Sheet, Tax Summary.
5. **Bank feeds** — Mono connection, webhook sync, Reconcile screen wired to live data.
6. **Polish & deploy** — role-based UI restrictions, audit log surfaced somewhere, production deploy.

## 9. Kickoff prompt for Claude Code

Paste this as the opening message in a new Claude Code session, with `schema.sql`, this file, and `business-finance-manager.jsx` (as a UI/behavior reference) in the project folder:

> Build a multi-user web app per `PRODUCTION_BUILD_SPEC.md` and `schema.sql` in this folder. Use Option A (Supabase + Next.js) unless I say otherwise. Reference `business-finance-manager.jsx` for exact UI behavior, calculations, and copy — port its logic rather than redesigning it. Start with Phase 1 from §8 (foundation: schema, auth, organizations) and stop for my review before moving to Phase 2.
