# Accounting software for SMEs

_Started 2026-08-21 09:43 UTC_

---

## User

Build a complete Book keeping/ Accounting AI based Software/app for me that can be used by SMEs, Businesses, entrepreneurs, and churches and NGOs. Disregard all the figures in the uploaded files. Let me be professional like sage and Quickbooks

## Assistant



## Assistant

_[tool: read_file]_

_[tool: read_file]_

Before I build: the spec is detailed, but a few decisions change the shape of the app significantly.

_[tool: ask_user]_

Waiting on your answers — mainly the entity-type question (whether churches/NGOs get real fund accounting) and how much to build in this pass, since those set the structure.

## User

Answered — entity_modes: SME / business (P&L, invoicing, inventory, tax), Church (tithes, offerings, projects, member giving); scope: Full working prototype — every module clickable with sample data; currency: ₦ Naira / Nigeria (VAT, PIT/CIT); ai_surfaces: Auto-categorize transactions, Bank reconciliation auto-match; platform: Desktop + responsive mobile; users: A Nigeria SME owner with no accounting training needs tax-ready numbers

## Assistant



## Assistant

_[tool: ask_user]_

Waiting on the visual direction — feel, accent, density. Then I'll build the full prototype (SME + Church modes, ₦/Nigeria tax).

## User

Answered — vibe: Institutional — navy/serif, formal, reads like a bank statement; density: Balanced

## Assistant

Building it now — this is a large single component, so one pass.

_[tool: dc_write]_

_[tool: ready_for_verification]_

**Ledgerly** — full working prototype, navy/serif institutional, ₦/Nigeria.

Nine screens, all live off one ledger: Dashboard (8 drill-down KPIs, P&L chart, 6-month cash forecast, category bars), Transactions, Invoices/Pledges, Bills, Contacts, Inventory, Reconcile, Reports, Settings.

Working: adding transactions posts to every report; recording a payment updates aging + cash; stock moves post their own ledger entries; AI categorisation codes the three uncoded entries; bank auto-match reconciles by amount + date proximity; editing a deductibility % in Settings recalculates the tax summary. Toggle top-right switches to church books — fund accounting, Statement of Activities, fund balances, pledges instead of invoices, tax-exempt.

Two things I deliberately left out, say the word: receipt attachments (needs real file storage) and the loan schedule.

## User

While recording a new Transaction, there should be an option to create a new category that was not included in the template. Give the option to create a new chart of accounts for both churches and Businesses.

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

Added in two places:

**In the transaction form** — the Category dropdown now ends with "+ Create a new category…". Pick it and a name field appears (plus an "allowable against tax %" field for expenses). Saving creates the account and codes the transaction to it in one step.

**Settings → Chart of accounts** — a new card above the deductibility list. Add income/giving accounts and expense accounts (with their allowable %) directly; remove an income account if nothing is posted to it. Separate charts per book, so the church side gets its own giving and expenditure accounts.

## User

include in both Church account and Business account an option to import Bank Statement directly into the software through Spreadsheets, Google sheets, Microsoft excel or CSV file. The Ai should be able to automatically match or map expenses or income to related category.

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the import overlay and the buttons that open it.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the parsing and mapping logic.

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: grep]_

_[tool: grep]_

_[tool: dc_js_str_replace]_

_[tool: read_file]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

Statement import is now real, in both books. Reachable from **Reconcile → Import statement** and **Transactions → Import statement**.

Four sources: CSV file, Excel workbook (.xlsx/.xls, parsed in the browser), Google Sheets share link (fetched and read directly), or paste cells straight from a spreadsheet. Columns are detected automatically — date/narration/amount, or a separate debit/credit pair — and dates in dd/mm/yyyy, dd-Mmm-yy and ISO all parse.

Then a review step: every row gets a category mapped from the bank narration against your chart of accounts, tagged AI matched / Needs review, each one overridable from a dropdown before anything posts. In church books each row also lands in the right fund — building, missions and benevolence giving route to their restricted funds. Posting creates the transactions and marks the statement lines reconciled in one step.

There's a "Load a sample statement" link under the paste option if you want to try it without a real file.

## User

Found issues — fixing…

## Assistant

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

Three fixes:

1. **Dates were one day early** east of UTC — `iso()` was formatting via UTC. Now formats from local parts, so seeded dates, "today", and imported statement dates all land on the right day.
2. **Method column** in business books showed "—" on every row; now shows the actual payment method (fund column stays for church books).
3. **Imported rows** no longer duplicate the full narration into Client/Vendor — bank prefixes (TRF FRM, POS, CARD, NIP…) are stripped, and if nothing meaningful remains the column is left blank.

## User

Let there be an option to create a new CLIENT in invoice and a new VENDOR in bills

## Assistant

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

The Client / Vendor / Member dropdown in the invoice, pledge and bill forms now ends with "+ Create a new record…". Picking it reveals name, email and phone fields; saving creates the contact and the document together, and the new record appears in Contacts with its activity history from that point on. Duplicate names reuse the existing contact instead of creating a second one.

## User

Found issues — fixing…

## Assistant

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

Fixed: contact rows now join only the fields that exist, falling back to "No contact details yet"; the contact detail panel shows "Not recorded" instead of a blank line.

## User

Change the colour theme to Black and Yellow. Make it professional and Premium

## User

Change the colour theme to Black and Yellow. Make it professional and Premium

## User

Found issues — fixing…

## User

Found issues — fixing…

## User

fix issues

## Assistant

_[tool: ready_for_verification]_

The contrast fixes are already in. I've sent the app back through a full review pass — if anything else turns up I'll fix it and report back.

If you meant a specific problem you're seeing, tell me which screen and what looks wrong.

## User

Found issues — fixing…

## Assistant

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

Now the muted label contrast.

_[tool: run_script]_

_[tool: ready_for_verification]_

Bank statements are now per-book, like every other ledger collection. Each organisation has its own statement lines (the church gets its own Zenith Bank feed), and matching, unmatching, importing and the reconciliation banner all read and write inside the active book — no more leakage between the business and church accounts.

Also darkened the muted label colour to clear the 4.5:1 contrast minimum.

