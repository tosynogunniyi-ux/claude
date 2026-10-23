# Sign up and pricing tiers

_Started 2026-08-21 18:21 UTC_

---

## User

Continuing from "Accounting software for SMEs".

## Assistant

We were building **Ledgerly** — a full-stack accounting app for Nigerian SMEs, businesses, churches and NGOs in ₦ Naira. The goal: tax-ready numbers, professional institutional feel (now black/gold instead of navy), every module clickable with live sample data.

**Decisions made:**
- Entity toggle at top-right switches between business (P&L, invoicing, inventory, tax) and church (fund accounting, pledges, member giving, tax-exempt).
- Nine core screens all feed one ledger: Dashboard, Transactions, Invoices/Pledges, Bills, Contacts, Inventory, Reconcile, Reports, Settings.
- Bank statement import (CSV, Excel, Google Sheets, paste) with AI auto-categorization; rows tagged "matched" or "needs review" before posting.
- Chart of accounts and category creation inline — both in transaction forms and Settings, with tax deductibility % per account.
- Contacts created on-the-fly in invoice/bill/pledge forms; duplicate names reuse existing records.
- Bank statements, ledger entries, and all reconciliation state live inside the active book (no cross-book leakage).

**Current state:**
Black/gold colour scheme applied throughout with 4.5:1+ contrast on all labels. Every workflow end-to-end tested: importing statements, auto-matching, overriding categories, posting to ledger, drilling into reports, toggling church mode. Sample data seeded in both books with correct dates (local timezone, not UTC). Contact creation, duplicate handling, and statement per-book isolation all live.

**Open next steps:**
- Receipt attachment (deferred — needs file storage backend).
- Loan amortization schedule (deferred).
- Any remaining UX issues from the verifier agent results.

**Files:**
- Ledgerly.dc.html (main app, all modules and logic).

## User

Create a Sign up and log in page.
Upon sign up, user should be able to pick between  Church Books and SMEs, Business, Company books.
Your access will be limited to your selection after sign up.

There should be 14 days free trial upon sign up after which the user will be automatically charged on monthly or yearly basis depending on the payment plan choice.

Monthly plan access is N5,000 for a single user while annual plan will attract 5% discount.

Multiple user will attract additional N5,000 access fee monthly per additional user and N57,000 annually

## Assistant

_[tool: grep]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

Added an auth gate in front of the app:

- **Log in** (any valid email + password) or **Create account** in three steps: account details → book type → plan.
- Book choice is **SME/Business/Company** or **Church/Non-Profit**; it sets `mode` on signup and the switch-books button is gone, so access stays limited to the selection. Sign out from the sidebar to change it.
- Plan step: ₦5,000/user monthly or ₦57,000/user yearly (5% off), with a user stepper that adds the same rate per extra user, a line-itemised total, first-charge date (14 days out), and a confirmation checkbox.
- Header now shows a trial pill ("Trial · 14 days left") that links to Settings; sidebar shows the signed-in name and initials from the account.

Billing is display-only — no payment capture screen. Say the word if you want a card-details step or a Settings billing panel to manage users and cancel.

## User

Found issues — fixing…

## Assistant

_[tool: grep]_

_[tool: read_file]_

Now the four fixes.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

All four addressed: breadcrumb now derives from the active organisation, seat stepper and agree checkbox use functional state updates, header buttons no longer wrap, and Settings has a Subscription panel at the top — trial status, cycle switch (monthly / yearly −5%), seat count, next charge date and amount, plus cancel.

## User

You are a Senior UI/UX Consultant and Design Systems expert specializing in Fintech and B2B SaaS products for the African market. The UI/UX does not reflect the professionalism and trustworthiness required for a financial product.

Objective:
Provide a strategic redesign improvement plan for my existing interface. Do not rebuild from scratch. Instead, identify specific design flaws and provide actionable enhancements to make the interface clean, modern, professional, and user-friendly, while keeping the existing structure intact.

Please analyze and provide improvements for the following areas:

1. Visual Design Enhancements (Fixing the "Flat" Look)
Color Strategy:
Analyze my current color palette (I will share it with you). Suggest minimal, high-impact changes—new primary/secondary accent colors, better contrast ratios, and strategic use of color to indicate status (paid, overdue, pending). Provide HEX codes for the updated palette.

Typography & Readability:
Review my current font choices. Suggest better font pairings (Google Fonts) that improve readability on both desktop and mobile. Define clear hierarchy (H1, H2, H3, body, small text) with specific sizes and weights.

Elevation & Depth:
Since the design is currently flat, suggest where to add subtle shadows, borders, or background tints to create depth. Specify exactly which UI elements should have shadows (cards, modals, dropdowns, buttons) and provide the CSS box-shadow values.

Whitespace & Spacing:
Identify areas where the interface feels cluttered. Recommend a consistent spacing system (e.g., 8px grid) and specify which sections need more breathing room.

2. UI Component Refinements
Navigation/Sidebar:
Critique my current navigation. Suggest improvements like collapsible sidebar, better icon-label alignment, active state highlights, and grouping of related menu items.

Dashboard KPI Cards:
Redesign the metrics cards (Revenue, Expenses, Outstanding Invoices). Suggest better layouts, micro-interactions (hover effects), and visual indicators (trend arrows, percentage changes) to make data scannable at a glance.

Data Tables (Invoices/Transactions):
Identify pain points in my current table design. Suggest improvements like:

Sticky headers

Row hover states

Status badges with better color coding

Action buttons (View, Edit, Delete) with clear icons

Pagination or infinite scroll improvements

## Assistant

_[tool: grep]_

_[tool: read_file]_

Read the current build. Here's the audit and the plan — no rebuild, all changes are swaps into what already exists.

## What's actually wrong

The build isn't "flat" by accident: every surface uses the same three values — `#FBFAF7` fill, `1px solid #D9D4CA` border, `3px` radius, zero shadow. A KPI card, a table shell, a settings panel and a modal are visually identical, so nothing tells the eye what's primary. Second problem: gold `#E3B23C` is doing four different jobs (brand mark, card top-rule, hover fill, trial pill), so it has no meaning. Third: `#6B6659` carries almost all secondary text at 10–11.5px — that's the main trust-killer on mobile.

## 1. Colour

Keep the black/gold. Fix the semantics.

**Structural (change these):**
- App canvas `#F1F0EA` → `#F4F3EE` — slightly cooler, lets white cards lift.
- Card surface `#FBFAF7` → `#FFFFFF`. This single change does more for depth than any shadow.
- Border `#D9D4CA` → `#E5E1D8` (quieter, since cards now carry shadow instead of outline).
- Muted text `#6B6659` → `#5C5850` (7.2:1 on white, vs 5.1 now).
- Ink stays `#131313`. Sidebar stays `#131313`.

**Gold, restricted:** `#E3B23C` for brand/trial/premium only. Interactive gold `#A8811C` on light backgrounds only. Remove the gold `border-top: 3px` from KPI cards — that's where the semantic colour belongs instead.

**Status ramp (new, use everywhere a state is shown):**

| State | Fill | Text | Dot/rule |
|---|---|---|---|
| Paid / Reconciled | `#E8F3EC` | `#1E5B3F` | `#2E6B4F` |
| Pending / Sent | `#FDF4E0` | `#7A5A0C` | `#C9A227` |
| Overdue / Unmatched | `#FBEBE7` | `#8A2F1D` | `#9E3A26` |
| Draft / Void | `#F0EFEA` | `#5C5850` | `#A8A296` |

Every badge becomes fill + 600 weight + a 6px leading dot in the dot colour — colour-blind users get the dot position and the word, not just hue.

## 2. Typography

The pairing is good — Source Serif 4 + IBM Plex Sans + Plex Mono is exactly right for a ledger product; don't change fonts. The scale is the problem: 27 / 23 / 17 / 13 / 12.5 / 11.5 / 10 has seven steps with no rhythm and bottoms out too small.

Replace with six steps:

- **H1** page title — Source Serif 4, 30px / 1.15 / 700, `-0.02em`
- **H2** card title — Source Serif 4, 19px / 1.3 / 600
- **H3** subsection — Plex Sans, 14px / 1.4 / 600, `0.01em`
- **Body** — Plex Sans, 14px / 1.55 / 400 (up from 13/12.5 — this is the biggest readability win)
- **Small** — Plex Sans, 12.5px / 1.5 / 400, colour `#5C5850`
- **Eyebrow/label** — Plex Sans, 11px / 600 / `0.12em` uppercase (up from 10px)
- **Numerals** — Plex Mono 13px, `tabular-nums`, everywhere money appears. KPI figures stay Source Serif 4 but go 28px/600.

Mobile: don't scale down. Below 640px, body stays 14px and eyebrows stay 11px; reduce padding instead.

## 3. Elevation

Three tiers only. Cards get shadow *and lose* their heavy border.

```
--e1 cards, KPI tiles, table shell:
  0 1px 2px rgba(19,19,19,.04), 0 1px 3px rgba(19,19,19,.06)
--e2 hover, dropdowns, popovers, sticky table header:
  0 2px 4px rgba(19,19,19,.05), 0 4px 12px rgba(19,19,19,.09)
--e3 modals, import drawer:
  0 12px 32px rgba(19,19,19,.14), 0 2px 8px rgba(19,19,19,.08)
```

Modal backdrop `rgba(19,19,19,.42)`. Primary buttons get `0 1px 2px rgba(19,19,19,.18)` and `translateY(-1px)` + `--e2` on hover. Inputs stay flat with `inset 0 1px 2px rgba(19,19,19,.04)`; focus ring `0 0 0 3px rgba(227,178,60,.28)` + border `#A8811C`. Radius 3px → **6px** on cards/buttons/inputs, 8px on modals. Keep 3px on badges.

## 4. Spacing

Move to a strict 4/8 scale: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Current values (9, 11, 13, 14, 18, 26, 44) are ad-hoc and read as sloppy at close range.

- Card padding `18px 20px` → `24px`
- Table cell `9px 14px` → `12px 16px` (rows go from 33px to ~44px — the single biggest "professional" gain in the app)
- Grid gaps 16px between cards, 24px between page sections
- Main content padding 24px → 32px desktop, 16px mobile
- Page header → content: 24px, with a `1px #E5E1D8` rule above the content

Cluttered spots specifically: the transactions filter bar (five controls in a flat row — group search+filters left, actions right, with a 24px gap), and the plan step of signup (stack is doing 10/12/14px alternately).

## 5. Sidebar

Currently: flat list of nine items, no grouping, badge counts in mono at 10.5px, active state is a background tint only.

- **Group into three labelled sections** — `MONEY IN` (Dashboard, Invoices/Pledges, Contacts), `MONEY OUT` (Bills, Transactions, Inventory), `CONTROL` (Reconcile, Reports, Settings). Group labels 10px/`0.14em`/`#6E6A60`.
- **Active state:** 3px `#E3B23C` left bar + `rgba(255,255,255,.07)` fill + white text at 600. Right now it's ambiguous which is selected.
- **Icons:** add a 16px monoline icon column, 12px gap, fixed 20px slot so labels align regardless of icon width.
- **Collapse:** 236px → 64px icon rail, toggle pinned at the bottom, state persisted. Tooltips on hover when collapsed.
- **Item height** 32px → 40px (hit target).
- Badges: pill `rgba(227,178,60,.16)` / `#E3B23C`, not bare mono text.

## 6. KPI cards

Currently label / big number / caption — no comparison, so the number means nothing.

New anatomy, top to bottom: eyebrow label · big figure (28px Source Serif) · **delta row** — arrow glyph + `12.4%` + "vs. last month" · 40px sparkline in the semantic colour at 18% opacity fill. Delta green `#2E6B4F` / red `#9E3A26`, and invert for expense cards (expenses up is red, revenue up is green — the current build would colour both the same).

Micro-interactions: `--e1` → `--e2` and `translateY(-2px)` over 160ms `cubic-bezier(.2,.6,.3,1)`; sparkline fill goes 18% → 28%; a small "View →" appears bottom-right on hover to signal the card is clickable (right now nothing says so).

## 7. Data tables

- **Sticky header** — `position: sticky; top: 0; z-index: 2`, `#F7F5F0` fill, `--e2` shadow applied only once scrolled.
- **Row height** 44px, `#FFFFFF` / hover `#F7F5F0` with a 2px `#E3B23C` inset left bar so the hovered row is unambiguous when scanning across eight columns.
- **Zebra:** no. With 44px rows and hover, striping adds noise.
- **Status column** uses the ramp above, dot + label.
- **Actions:** replace the single "Open" button with a right-aligned 3-icon cluster (eye / pencil / ⋯) that is `opacity: 0` until row hover, `opacity: 1` on focus-within for keyboard users. Destructive actions live in the ⋯ menu, never inline.
- **Money columns** right-aligned, tabular, and overdue balances in `#8A2F1D` at 600.
- **Pagination**, not infinite scroll — accountants reconcile by position ("row 40 of 212"). 50/row default, page controls bottom-right, count bottom-left. Infinite scroll breaks Ctrl+F and print.
- **Empty and loading states** — currently a table renders as an empty box. Add a centred empty state with the primary action, and 6 shimmer rows on load.

## Sequencing

Do it in this order, highest impact first: white card surfaces + the three shadow tiers → 44px table rows and 24px card padding → the status colour ramp → the type scale → KPI deltas and sparklines → sidebar grouping and collapse → table sticky headers and icon actions.

Want me to apply this to `Ledgerly.dc.html`? I'd suggest starting with steps 1–3 (surfaces, spacing, status colour), which touch every screen and are where the professionalism gap actually lives — then you judge before I go on to the KPI and sidebar work.

## User

ok. Start with step 1-3

## User

ok. Start with step 1-3

## User

Found issues — fixing…

## Assistant

_[tool: grep]_

_[tool: run_script]_

_[tool: ready_for_verification]_

KPI cards now match the rest: 20px padding, `--e1` shadow, hover transition. The top rule is semantic instead of blanket gold — green on income, red on expenses, green/red on profit by sign, amber only when transactions are awaiting coding, neutral `#E5E1D8` otherwise.

## User

ok. Go ahead and finish the design

## Assistant

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

Now the nav logic, KPI deltas and sparklines.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

Now the KPI card markup, status dots, sticky headers, row-hover bar, and the type scale.

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: run_script]_

_[tool: grep]_

_[tool: run_script]_

_[tool: ready_for_verification]_

Steps 4–7 are in:

**Sidebar** — grouped into Money in / Money out / Control with 17px monoline icons on a fixed slot, 40px rows, active state as a gold 3px left bar plus subtle white fill (no more solid gold block), pill badges, and a collapse toggle that drops the rail to 68px with icons and tooltips.

**KPI cards** — 220px min, 16px gaps, 28px figures, and on income / expenses / profit a delta row (▲▼ percentage vs. last month, expense polarity inverted) over a six-month sparkline. Hover lifts 2px into `--e2`.

**Type scale** — H1 30, H2 19, body 14, small 12.5, eyebrows 11/600/0.12em; line-height 1.55 on body. Nothing below 11px now.

**Tables** — sticky headers with a hairline shadow, hover rows carrying a 2px gold inset bar, status badges and category chips as dot + label, and transactions paginated 50/page with range and page counters, plus an empty state that offers the import action.

## User

Found issues — fixing…

## Assistant

_[tool: run_script]_

_[tool: ready_for_verification]_

Collapsed rail fixed: `overflow: hidden` on the aside, the count pill hidden when collapsed and replaced by a small gold dot pinned inside the icon, the active bar moved to `position: absolute; left: 0` so icons centre in the 68px rail, and the collapse toggle centres with them.

## User

let users be able sign up and sign in using gmail

## Assistant

_[tool: read_file]_

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

Google auth added to both paths:

- **Sign in with Google** on the login card — signs straight in to the existing account.
- **Sign up with Google** on step 1 — fills name and email, marks the account as Google-connected, and replaces the password field with a "Google account connected" note plus an escape link to set a password instead. Book choice and plan steps are unchanged, so the trial still starts the same way.

It's a simulated OAuth handshake — no real Google endpoint. Wiring it to actual Google Identity Services needs a client ID and a backend to verify the token.

## User

Found issues — fixing…

## Assistant

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

Exposed the missing `isGoogle` / `noProvider` / `dropGoogle` values — the password field is back on email signup, and the Google path now shows the connected banner with a working "Use a password instead" link.

## User

user should be required to input credit card or debit card details during sign-up, immediately after the plan has been picked so that the card can be automatically charged after the trial period or for subscription renewal

## Assistant

_[tool: run_script]_

_[tool: read_file]_

_[tool: run_script]_

Now the logic for step 4.

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

Signup is now four steps — Account, Books, Plan, **Card**. The plan step's CTA reads "Continue to payment details"; the trial only starts once a card is on file.

The card step shows what will be charged and when, then takes name, number (auto-spaced, brand detected — Visa / Mastercard / Verve), expiry as MM/YY and CVV. Validation runs Luhn on the number, rejects expired cards, requires a 3-digit CVV, and requires the authorisation checkbox before "Start 14-day free trial". The number and CVV are cleared from state after submit; only brand, last 4 and expiry are kept, and those surface as a Payment method column in the Settings subscription panel.

