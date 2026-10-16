# Design sweep and authenticity

_Started 2026-08-23 14:48 UTC_

---

## User

Continuing from "Sign up and pricing tiers".

## Assistant

We were finishing a professional redesign of **Ledgerly** — an accounting app for Nigerian SMEs, churches, and NGOs in ₦ Naira. The goal was moving from a flat, low-trust look to a fintech-grade interface that signals institutional credibility for financial users.

**Decisions made:**
- Colour: white card surfaces instead of off-white, three shadow tiers for depth (`--e1` cards, `--e2` hover/dropdowns, `--e3` modals), status ramp for all states (paid green, pending amber, overdue red, draft neutral) with leading dots for colour-blind users.
- Typography: six-step scale (H1 30px, H2 19px, body 14px, small 12.5px, eyebrows 11px/600) replacing the seven-step ad-hoc scale; Plex Mono for all currency figures.
- Spacing: strict 4/8 grid; 24px card padding, 44px table rows, 32px main content margin — reads far more professional than the 9–14px ad-hoc values.
- Sidebar: grouped into Money In / Money Out / Control with 17px icons, 40px rows, gold 3px left bar on active, collapse toggle drops to 68px icon rail with tooltips.
- KPI cards: 28px figures, delta row (percentage vs. last month, inverted for expenses), six-month sparkline, 2px lift on hover.
- Tables: sticky headers with shadow, 2px gold inset bar on hover row, status badges with dots, 50/page pagination with range/count counters.
- Google OAuth: sign in / sign up via Gmail with simulated handshake (no live endpoint yet).
- Payment: added step 4 to signup — card details (name, number with brand detection, expiry, CVV) with Luhn validation, trial starts only after card is on file, last-4 and expiry stored in Settings.

**Current state:**
All seven design steps (surfaces, spacing, colour, type, elevation, KPI/sparklines, sidebar/tables, Google auth, payment capture) are live end-to-end. Card inputs auto-space and validate; expired cards and invalid CVV reject. Settings subscription panel shows payment method, trial countdown, cycle switcher, seat count, next charge date, and cancel. Sidebar collapses and expands with pinned count dots.

**Open next steps:**
- Wire Google OAuth to real Google Identity Services (needs client ID + backend token verification).
- Wire card processor (Stripe / Paystack / Flutterwave) for live charging at trial end and renewal.
- Receipt attachment (deferred).

**Files:**
- Ledgerly.dc.html (all modules, auth, signup, design system, payment step).

## User

Do a Quick Sweep through the design. D not make it look like a generic AI-generated Landing page. Treat it like a real creative

## Assistant

_[tool: grep]_

_[tool: list_files]_

_[tool: show_html]_

_[tool: show_html]_

_[tool: grep]_

_[tool: read_file]_

_[tool: grep]_

_[tool: save_screenshot]_

_[tool: multi_screenshot]_

_[tool: multi_screenshot]_

_[tool: grep]_

_[tool: grep]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: eval_js_user_view]_

_[tool: eval_js_user_view]_

_[tool: eval_js_user_view]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

Restructuring the KPI wall into a hierarchy and rebuilding the forecast chart.

_[tool: run_script]_

_[tool: multi_screenshot]_

_[tool: multi_screenshot]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: run_script]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

Swept the dashboard; four changes, all structural rather than decorative:

- **Broke the eight-card wall into a hierarchy.** Income, Expenses, Profit/Loss and Cash Balance stay as full cards (Cash Balance now carries a running-balance sparkline so the row reads evenly); AR, AP, Stock and Uncategorised drop to a single divided stat band underneath — a real ledger's summary strip, not eight identical tiles.
- **Rebuilt the cash flow forecast.** Slim capped bars (soft fill, 2px coloured cap) on a continuous baseline with a dashed ceiling rule, instead of six solid gold blocks.
- **Killed the label wraps** that were splitting delta rows, category names and the sidebar user name into two lines at narrower widths — deltas hold one line, category names truncate rather than fold over their bars.

Everything else — palette, type scale, tables, auth, signup, billing — untouched.

## User

<pasted_text name="Pasted text (1976 lines)">
# PROFITINA — MASTER PRODUCT REDESIGN, REBRAND &amp; PRODUCT UPGRADE PROMPT

## ROLE

You are a world-class product designer, SaaS UX strategist, fintech product architect, UI designer, and frontend engineer.

You are working on an existing accounting SaaS product currently called **Ledgerly**.

Your task is to **transform and upgrade the existing Ledgerly product into a premium Nigerian accounting and business-finance platform called PROFITINA**.

Do NOT simply change the logo and product name.

Treat this as a **complete product evolution**.

Preserve useful existing functionality and information architecture where appropriate, but redesign the experience, navigation, dashboard, workflows, visual system, copy, and feature architecture so the result feels like a mature, venture-backed fintech/SaaS product.

The final product should feel like something a serious Nigerian SME would confidently pay for and use every day.

---

# 1. NEW BRAND

## Product Name

**PROFITINA**

## Brand Positioning

**Profitina is an AI-powered financial operating system built for Nigerian businesses.**

It helps business owners:

* Track income and expenses
* Create and manage invoices
* Collect payments
* Manage customers
* Manage inventory
* Track suppliers
* Manage expenses
* Reconcile transactions
* Run payroll
* Monitor profitability
* Prepare tax information
* Automate financial tasks
* Receive intelligent business insights
* Follow up customers automatically
* Reduce repetitive accounting work

Profitina should feel like a combination of:

**Accounting + Business Management + Automation + AI Financial Assistant**

rather than just bookkeeping software.

---

# 2. BRAND TAGLINE

Primary tagline:

**Know Your Numbers. Grow Your Business.**

Secondary positioning:

**AI-powered accounting and business finance for Nigerian businesses.**

Alternative supporting statement:

**Run your business. Automate your finances. Know your profit.**

Use the primary tagline prominently on the marketing website.

---

# 3. CORE DESIGN DIRECTION

The website and application must look:

* Premium
* Professional
* Modern
* Sophisticated
* Trustworthy
* Human-designed
* Fintech-grade
* Nigerian-market relevant
* Enterprise-quality
* Clean
* Creative
* Highly usable

IMPORTANT:

**DO NOT make the website look AI-generated.**

Avoid:

* Excessive gradients
* Generic AI illustrations
* Futuristic glowing interfaces
* Excessive glassmorphism
* Random floating shapes
* Overuse of purple/blue AI aesthetics
* Generic robot imagery
* Excessive rounded cards
* Stock-looking SaaS illustrations
* Huge meaningless dashboards
* Excessive animations
* Template-like layouts

The visual language should resemble a premium modern financial product.

Think:

**Stripe + Mercury + Ramp + modern African fintech + premium Nigerian SaaS**

but do NOT copy any company's interface.

Create an original visual identity for Profitina.

---

# 4. BRAND PERSONALITY

Profitina should communicate:

### Confidence

"Your business finances are under control."

### Simplicity

"Accounting doesn't have to be complicated."

### Intelligence

"Profitina helps you understand what your numbers mean."

### Automation

"Stop doing repetitive financial work manually."

### Growth

"Know what's making money and what's costing you money."

### Trust

"Your business financial data is organized, visible and secure."

Tone of voice:

* Clear
* Confident
* Helpful
* Professional
* Intelligent
* Human
* Entrepreneur-friendly

Avoid overly technical accounting language.

---

# 5. TARGET USERS

Design the product primarily for:

### Small Business Owners

Examples:

* Retail stores
* Fashion businesses
* Restaurants
* Supermarkets
* E-commerce businesses
* Service businesses
* Consulting firms
* Agencies
* Schools
* Churches
* Contractors
* Wholesalers
* Distributors
* Manufacturers

### Accountants

Accountants should be able to manage multiple businesses and clients.

### Growing SMEs

Businesses that need more than Excel but aren't ready for complex enterprise accounting software.

---

# 6. NIGERIAN-FIRST EXPERIENCE

Profitina should clearly understand the Nigerian business environment.

Use:

* Nigerian Naira ₦
* Nigerian date formatting where appropriate
* Nigerian business terminology
* VAT
* WHT
* PAYE
* Nigerian tax concepts
* Nigerian bank transactions
* Nigerian business types
* Nigerian customer names
* Nigerian phone number formats
* Nigerian addresses
* Nigerian payment methods

Use realistic Nigerian sample data.

Examples:

Customers:

* Chinedu Okafor
* Aisha Bello
* Tolu Adeyemi
* Emeka Nwosu
* Blessing Eze
* Daniel Okoro

Businesses:

* Mideops Ventures
* Bella Fashion House
* Prime Foods Ltd
* Warri Tech Solutions
* Lagos Home Supplies
* Delta Fresh Mart

Do NOT overdo Nigerian cultural elements.

The interface should feel globally premium while being specifically useful to Nigerian businesses.

---

# 7. GLOBAL APPLICATION NAVIGATION

Create a clean left sidebar navigation.

Primary navigation:

### Overview

Dashboard

### Sales

* Invoices
* Estimates
* Customers
* Payments
* Recurring Invoices

### Purchases

* Expenses
* Bills
* Suppliers
* Purchase Orders

### Inventory

* Products
* Stock Levels
* Stock Movements
* Warehouses
* Low Stock Alerts

### Accounting

* Chart of Accounts
* Transactions
* Bank Reconciliation
* Journal Entries
* General Ledger

### Payroll

* Employees
* Payroll Runs
* Payslips
* Payroll Reports

### Tax

* VAT
* WHT
* PAYE
* Tax Reports
* Tax Calendar

### Automation

* Automation Rules
* Reminders
* Scheduled Tasks
* Workflows

### AI Assistant

* Ask Profitina
* Financial Insights
* Cash Flow Forecast
* Profit Analysis
* AI Reports

### Reports

* Profit &amp; Loss
* Balance Sheet
* Cash Flow
* Sales Reports
* Expense Reports
* Inventory Reports
* Tax Reports
* Customer Reports

### Settings

* Business Profile
* Users &amp; Roles
* Notifications
* Integrations
* Subscription
* Security

---

# 8. MAIN DASHBOARD

The dashboard should be the heart of Profitina.

Create a sophisticated financial command center.

Header:

**Good morning, Tosin**

Subtext:

**Here's how your business is doing today.**

Include a date selector.

Example:

**25 August 2026**

---

## KEY FINANCIAL METRICS

Create premium metric cards:

### Revenue

₦18,450,000

↑ 12.4%

vs previous month

### Expenses

₦7,240,000

↓ 4.8%

vs previous month

### Net Profit

₦11,210,000

↑ 18.6%

vs previous month

### Cash Balance

₦24,680,500

---

# 9. PROFITINA AI INSIGHTS

Create a prominent but sophisticated AI section.

Title:

**Profitina Intelligence**

Example insights:

&gt; Your revenue increased 12.4% this month, but inventory purchases increased 21%. Review your top 5 suppliers to identify possible margin pressure.

Another:

&gt; ₦1.84M in outstanding invoices are currently overdue.

Another:

&gt; Based on your current spending pattern, your cash balance may fall below ₦5M within 38 days.

Another:

&gt; Your best-performing product this month is Premium Office Chair with ₦1.2M in gross profit.

Provide buttons:

**Review Insight**

**Ask Profitina**

Do not make this look like a chatbot gimmick.

AI should feel integrated into the financial workflow.

---

# 10. AI ACCOUNTING ASSISTANT

Create a powerful AI assistant called:

**Profitina AI**

Subtitle:

**Your intelligent financial assistant.**

Users should be able to ask:

* "How much did we make this month?"
* "What are my biggest expenses?"
* "Who owes me money?"
* "Which customers are overdue?"
* "What products are most profitable?"
* "Why did profit fall this month?"
* "What is my cash flow forecast?"
* "Show me unpaid invoices."
* "Which expenses increased the most?"
* "What should I pay this week?"
* "Which customers haven't purchased recently?"
* "Prepare a monthly financial summary."
* "Explain my profit and loss statement."
* "What can I do to improve my profit margin?"

The assistant should return:

* Clear answers
* Supporting figures
* Relevant charts
* Links to the underlying records
* Suggested actions

Example:

User:

"Who owes me the most money?"

Profitina:

**Top Outstanding Customers**

1. Prime Foods Ltd — ₦1,240,000
2. Bella Fashion House — ₦780,000
3. Delta Fresh Mart — ₦520,000

Total outstanding:

**₦2,540,000**

Button:

**Send Reminders**

---

# 11. AI AUTOMATION ENGINE

This should be one of Profitina's major differentiators.

Create an **Automation Center**.

Headline:

**Let Profitina handle the repetitive work.**

Users should be able to create automation rules using simple natural language.

Example:

"When an invoice becomes overdue, send the customer a WhatsApp reminder."

"When stock falls below 10 units, notify me."

"When a customer pays an invoice, send a thank-you email."

"Every Monday morning, send me a cash flow summary."

"When a supplier bill is due in 3 days, remind me."

"When monthly revenue exceeds ₦10M, notify the business owner."

---

# 12. AUTOMATION BUILDER

Create a visual workflow builder.

Structure:

### WHEN

Trigger

↓

### IF

Condition

↓

### THEN

Action

Example:

WHEN:

Invoice becomes overdue

IF:

Outstanding amount &gt; ₦50,000

THEN:

Send WhatsApp reminder

AND:

Send email

AND:

Notify business owner

AND:

Create follow-up task

Use a clean workflow interface.

Include:

**Create Automation**

**Active Automations**

**Automation History**

---

# 13. INVOICE AUTOMATION

Invoice creation should be extremely easy.

Users can:

* Create invoice
* Add products/services
* Add customer
* Add tax
* Add discount
* Add payment terms
* Set due date
* Add notes
* Send invoice
* Schedule invoice
* Create recurring invoice

After sending an invoice, Profitina should automatically track:

* Sent
* Viewed
* Partially paid
* Paid
* Overdue

---

# 14. AUTOMATED INVOICE REMINDERS

Create a sophisticated reminder system.

Example:

Invoice due:

30 August

Automation:

**3 days before due date**
→ Send friendly WhatsApp reminder

**On due date**
→ Send email reminder

**3 days overdue**
→ Send WhatsApp follow-up

**7 days overdue**
→ Send stronger payment reminder

**14 days overdue**
→ Notify business owner

Allow users to customize each message.

Channels:

* Email
* WhatsApp
* In-app notification
* SMS where available

---

# 15. WHATSAPP INTEGRATION

WhatsApp should be a major part of the Nigerian SME experience.

Create WhatsApp actions for:

* Invoice delivery
* Payment reminders
* Receipts
* Payment confirmations
* Customer notifications
* Appointment reminders
* Order updates
* Stock alerts
* Internal notifications

Example:

**Send via WhatsApp**

"Hello Chinedu, this is a friendly reminder that Invoice #INV-2048 for ₦350,000 is due on 30 August 2026.

You can view and pay your invoice here: [Payment Link]

Thank you for your business."

Include a configurable WhatsApp integration area in Settings.

Do not claim the integration is operational unless an actual WhatsApp API integration exists.

Design the UI and architecture so the integration can be connected later.

---

# 16. EMAIL AUTOMATION

Create an email automation engine.

Users should be able to send:

* Invoice emails
* Payment reminders
* Receipts
* Statements
* Monthly reports
* Tax reminders
* Customer notifications

Create beautiful professional email templates.

Allow:

* Logo
* Brand colors
* Business name
* Signature
* Payment link
* Invoice attachment
* Custom message

---

# 17. INVENTORY MANAGEMENT

Create a powerful inventory module.

Features:

* Products
* SKU
* Product categories
* Cost price
* Selling price
* Quantity
* Reorder level
* Stock value
* Supplier
* Warehouse
* Stock movements

Inventory dashboard:

**Total Stock Value**

₦8,450,000

**Products**

428

**Low Stock**

17

**Out of Stock**

6

---

# 18. AI INVENTORY AUTOMATION

Profitina AI should analyze inventory.

Examples:

&gt; "Your stock of Premium Office Chair is likely to run out in 8 days based on recent sales."

&gt; "You have ₦2.4M tied up in slow-moving inventory."

&gt; "These 8 products have not sold in 60 days."

Actions:

**Create Purchase Order**

**View Products**

**Notify Manager**

---

# 19. CUSTOMER MANAGEMENT / CRM

Create a lightweight CRM.

Customer profile should show:

* Customer name
* Phone
* Email
* Address
* Total purchases
* Outstanding balance
* Last purchase
* Average order value
* Invoice history
* Payment history
* Notes

AI insight:

**Customer Health**

"Strong"

"Customer has purchased consistently for 8 months."

---

# 20. EXPENSE MANAGEMENT

Users should be able to:

* Record expenses
* Upload receipts
* Categorize expenses
* Assign expense accounts
* Track recurring expenses
* Attach documents
* Track vendors

AI functionality:

Allow Profitina AI to suggest categories.

Example:

Receipt:

₦85,000 — Office Supplies

Profitina suggests:

**Office Expenses**

Confidence:

94%

User can:

**Approve**

**Change Category**

---

# 21. BANK RECONCILIATION

Create a modern reconciliation interface.

Show:

**Bank Transactions**

vs

**Ledger Transactions**

Allow:

* Match
* Categorize
* Create transaction
* Ignore
* Split transaction

AI should suggest matches.

Example:

&gt; "Profitina found a likely match for this ₦250,000 transaction."

Buttons:

**Match**

**Review**

---

# 22. PAYROLL

Create:

* Employee records
* Salary structures
* Allowances
* Deductions
* Payroll runs
* Payslips
* Payroll reports

Use Nigerian payroll terminology.

Include:

* PAYE
* Pension
* Other applicable deductions

Keep compliance architecture flexible and clearly label any tax calculations as requiring verification/configuration where appropriate.

---

# 23. TAX CENTER

Create a dedicated:

**Tax Center**

Dashboard cards:

VAT

WHT

PAYE

Tax Calendar

Tax Reports

Create alerts:

&gt; VAT filing deadline approaching.

&gt; PAYE payment deadline approaching.

&gt; WHT records require review.

Do not present tax calculations as legally authoritative unless the system has been properly configured and validated.

---

# 24. REPORTING CENTER

Create beautiful professional financial reports.

Reports:

### Profit &amp; Loss

### Balance Sheet

### Cash Flow Statement

### General Ledger

### Trial Balance

### Sales Report

### Expense Report

### Customer Statement

### Supplier Statement

### Inventory Valuation

### Tax Reports

### Payroll Reports

Allow:

* Date filtering
* Comparison periods
* Export PDF
* Export Excel
* Print
* Email report

---

# 25. AI-GENERATED REPORT SUMMARIES

This should be a major differentiator.

At the top of every major report, include:

**Profitina AI Summary**

Example:

&gt; Revenue increased 14% compared with July, driven mainly by product sales. Operating expenses increased 6%, resulting in an overall 18% improvement in net profit.

Buttons:

**Ask AI About This Report**

---

# 26. CASH FLOW FORECASTING

Create:

**Cash Flow Forecast**

Show:

* Current cash
* Expected income
* Expected expenses
* Upcoming bills
* Outstanding invoices
* Forecast balance

Example:

**Projected Cash Balance**

₦18.2M

30 days

₦14.8M

60 days

₦11.4M

90 days

Include warnings where appropriate.

---

# 27. BUSINESS HEALTH SCORE

Create a premium feature:

**Profitina Business Health**

Score:

**82 / 100**

Breakdown:

Cash Flow — 87

Profitability — 91

Collections — 74

Inventory — 79

Expenses — 85

Use this as an intelligent summary rather than a gimmicky gamification feature.

---

# 28. NOTIFICATIONS CENTER

Create a unified notification center.

Examples:

🔔 Invoice #INV-2048 is overdue

🔔 Stock for Product X is below reorder level

🔔 VAT deadline approaching

🔔 ₦450,000 payment received

🔔 Payroll is ready

🔔 Cash flow warning

🔔 AI insight available

Allow users to control notification preferences.

---

# 29. SETTINGS

Create comprehensive settings:

Business Profile

Users &amp; Permissions

Roles

Currency

Tax

Invoice Settings

Payment Settings

WhatsApp

Email

Bank Integrations

Notifications

Automation

AI Settings

Security

Subscription

Data Export

---

# 30. USER ROLES

Support:

Owner

Admin

Accountant

Manager

Sales Staff

Inventory Manager

HR/Payroll

Viewer

Allow granular permissions.

---

# 31. ONBOARDING

Create a beautiful onboarding experience.

Step 1:

**Welcome to Profitina**

"Let's get your business finances organized."

Step 2:

Business name

Step 3:

Business type

Step 4:

Industry

Step 5:

Currency

Default:

**NGN ₦**

Step 6:

Tax settings

Step 7:

Connect bank

Step 8:

Import existing data

Step 9:

Invite team

Step 10:

**You're ready to go.**

Show:

**Your Profitina workspace is ready.**

---

# 32. IMPORTING DATA

Support importing:

* Customers
* Products
* Invoices
* Expenses
* Transactions
* Suppliers

Allow:

CSV / Excel import.

Create a smart mapping interface.

Example:

CSV Column:

"Customer Name"

Profitina field:

"Customer"

CSV Column:

"Amount"

Profitina field:

"Invoice Amount"

---

# 33. LANDING PAGE

The public website should have a premium SaaS landing page.

Hero:

# Know Your Numbers. Grow Your Business.

**AI-powered accounting and business finance built for Nigerian businesses.**

Track your money, automate repetitive financial tasks, manage inventory, send invoices, follow up customers and understand your business — all from one intelligent platform.

Primary CTA:

**Start Free**

Secondary CTA:

**See How It Works**

---

# 34. HERO VISUAL

Do NOT use generic stock photography.

Create a sophisticated product-led hero.

Show a realistic Profitina dashboard with:

Revenue

Expenses

Profit

Cash Flow

AI Insights

Outstanding Invoices

Inventory

The dashboard should look like an actual working product.

Use subtle depth and shadows.

Avoid exaggerated 3D effects.

---

# 35. WEBSITE SECTIONS

Create:

### Hero

### Trusted by growing businesses

Use placeholder logos only if necessary.

### The Problem

"Accounting shouldn't slow your business down."

### The Solution

"One intelligent system for your business finances."

### Product Features

Accounting

Invoicing

Inventory

Payroll

Tax

Automation

AI

### AI Section

"Your numbers can now talk back."

### Automation Section

"Stop chasing invoices."

### WhatsApp Section

"Meet your customers where they already are."

### Inventory Section

"Know what you have before you buy more."

### Reporting Section

"Turn financial data into decisions."

### Security Section

"Your business data deserves serious protection."

### Pricing

Create a clean pricing section.

Use placeholders if pricing has not been finalized.

### FAQ

### Final CTA

**Your business is growing. Your accounting should grow with it.**

CTA:

**Start Using Profitina**

---

# 36. PRICING ARCHITECTURE

Create a scalable pricing model.

Suggested tiers:

### STARTER

For small businesses

### GROWTH

For growing businesses

### PRO

For established businesses

### ACCOUNTANT

For accountants managing multiple businesses

Do not hardcode final prices unless provided.

Use placeholders such as:

₦XX,XXX/month

---

# 37. ACCOUNTANT MULTI-BUSINESS MODE

Create a feature specifically for professional accountants.

Accountants can:

* Create client organizations
* Switch between businesses
* Manage multiple companies
* Review client dashboards
* Generate reports
* Reconcile accounts
* Manage permissions

Add:

**My Businesses**

Example:

Mideops Ventures

Prime Foods Ltd

Bella Fashion House

Warri Tech Solutions

---

# 38. AI ACTIONS

AI should not merely answer questions.

It should be able to recommend actions.

Example:

AI:

"You have ₦1.8M in overdue invoices."

Actions:

**Send Reminders**

**View Invoices**

**Create Collection Task**

Another:

"Product X will likely run out within 8 days."

Actions:

**Create Purchase Order**

**View Stock**

Another:

"Your expenses increased by 19%."

Actions:

**Analyze Expenses**

**Compare Months**

---

# 39. AI SAFETY / CONFIRMATION

Never allow AI to silently perform financially sensitive actions.

For actions involving:

* Payments
* Deleting records
* Sending bulk messages
* Payroll
* Tax submissions
* Bank transactions

Require explicit confirmation.

Example:

**Profitina wants to send payment reminders to 18 customers.**

[Review Messages]

[Cancel]

[Approve &amp; Send]

---

# 40. DATA VISUALIZATION

Use charts intelligently.

Preferred:

* Line charts
* Bar charts
* Donut charts
* Area charts
* KPI cards
* Tables

Avoid chart overload.

Every chart should answer a business question.

---

# 41. RESPONSIVE DESIGN

The product must work beautifully on:

* Desktop
* Laptop
* Tablet
* Mobile

Mobile should not simply shrink the desktop dashboard.

Create a proper mobile experience.

---

# 42. DESIGN SYSTEM

Create a consistent design system.

Use:

* Strong typography hierarchy
* Generous whitespace
* Consistent spacing
* Subtle borders
* Soft shadows
* Professional data tables
* Clear buttons
* Strong empty states
* Helpful tooltips

Use a restrained color palette.

Suggested direction:

Primary:

Deep charcoal / near-black

Secondary:

Warm off-white

Accent:

A sophisticated green associated with financial growth.

Supporting colors:

Muted blue

Amber

Red

Do not overuse the accent color.

---

# 43. TYPOGRAPHY

Use a modern professional sans-serif font.

Recommended:

**Inter**

or another high-quality modern UI font.

Typography should feel:

* Premium
* Highly readable
* Professional
* Modern

---

# 44. ICONOGRAPHY

Use a consistent modern icon set.

Icons should be:

* Minimal
* Functional
* Professional

Avoid cartoon-style icons.

---

# 45. TABLE DESIGN

Financial tables should be extremely readable.

Include:

* Sticky headers where appropriate
* Sorting
* Filtering
* Search
* Pagination
* Bulk actions
* Column visibility
* Export

Example invoice table:

Invoice

Customer

Amount

Issue Date

Due Date

Status

Actions

---

# 46. EMPTY STATES

Create intelligent empty states.

Example:

No invoices yet.

**Create your first invoice**

"Send professional invoices and let Profitina automatically follow up when they're due."

CTA:

**Create Invoice**

Do not use generic:

"No data found."

---

# 47. SAMPLE DATA

Populate the prototype with realistic data.

Do NOT use:

John Doe

Jane Doe

ABC Company

$10,000

Instead use realistic Nigerian data.

Currency:

₦

Businesses:

Mideops Ventures

Prime Foods Ltd

Bella Fashion House

Warri Tech Solutions

Customers:

Chinedu Okafor

Aisha Bello

Tolu Adeyemi

Emeka Nwosu

Use realistic transaction amounts.

---

# 48. MICROCOPY

Use human language.

Instead of:

"Execute transaction"

Use:

**Record Expense**

Instead of:

"Generate financial artifact"

Use:

**Create Report**

Instead of:

"Initiate receivables workflow"

Use:

**Send Reminder**

Instead of:

"AI-generated recommendation"

Use:

**Profitina suggests**

---

# 49. PREMIUM PRODUCT DETAILS

Add subtle details that make the product feel real:

* Keyboard shortcuts
* Search
* Command palette
* Recent activity
* User avatars
* Smart filters
* Saved views
* Export buttons
* Confirmation states
* Undo actions where safe
* Loading skeletons
* Toast notifications
* Tooltips
* Contextual help
* Audit trail

---

# 50. COMMAND CENTER

Add a global search / command palette.

Users can press:

**⌘ K**

or

**Ctrl + K**

to search:

* Customers
* Invoices
* Products
* Transactions
* Reports
* Settings

Also allow natural-language commands.

Example:

"Show overdue invoices."

"Create invoice for Chinedu."

"Show this month's expenses."

"Open cash flow."

---

# 51. AUDIT TRAIL

Create:

**Activity &amp; Audit Log**

Track:

* Who created records
* Who edited records
* Who deleted records
* Who sent invoices
* Who approved payments
* Automation activity
* AI actions
* Login activity

Example:

**Tosin updated Invoice #INV-2048**

Today, 8:42 AM

---

# 52. SECURITY UX

Create a premium security section.

Include:

* Two-factor authentication
* Login history
* Session management
* Role-based permissions
* Data export
* Audit logs

Do not make unsupported claims such as "bank-level encryption" unless actually implemented.

---

# 53. APPLICATION STATES

Design:

* Loading states
* Empty states
* Error states
* Success states
* Confirmation dialogs
* Warning states
* Permission denied states

Every major workflow should feel complete.

---

# 54. FINAL PRODUCT FEEL

When someone opens Profitina, they should immediately think:

&gt; "This is serious accounting software."

Then after exploring it:

&gt; "This was clearly designed for Nigerian businesses."

And after seeing the AI:

&gt; "This is much smarter than normal accounting software."

And after seeing automation:

&gt; "This can actually save me time."

That is the desired product experience.

---

# 55. CRITICAL IMPLEMENTATION INSTRUCTION

You are modifying an EXISTING Ledgerly project.

Therefore:

1. First inspect the existing application.
2. Identify reusable components.
3. Preserve useful existing functionality.
4. Rename Ledgerly references to Profitina.
5. Upgrade the visual design.
6. Upgrade the navigation.
7. Add the new modules.
8. Add realistic sample data.
9. Add AI interaction patterns.
10. Add automation workflows.
11. Add invoice reminder workflows.
12. Add inventory automation.
13. Add WhatsApp/email workflow interfaces.
14. Add Nigerian accounting context.
15. Ensure responsive design.
16. Ensure consistent design language across every screen.

Do not create a collection of disconnected mockup pages.

The application should feel like **ONE coherent product**.

---

# 56. IMPORTANT FUNCTIONALITY RULE

If a feature cannot actually be connected to a live external service in the current prototype, build the **complete frontend experience and integration architecture**, but clearly distinguish:

* Demo functionality
* Simulated data
* Future integration
* Live functionality

Never pretend that WhatsApp, banking, payment, tax filing or AI automation is actually operational when it is only a prototype.

---

# 57. BRAND NAME REPLACEMENT

Replace all references to:

**Ledgerly**

with:

**Profitina**

Update:

* Logo
* Browser title
* Navigation
* Login
* Signup
* Dashboard
* Emails
* Invoice templates
* Empty states
* Notifications
* Settings
* Footer
* Marketing website
* Metadata
* Buttons
* Documentation
* Sample content

The final product should contain no accidental references to Ledgerly.

---

# 58. FINAL QUALITY CHECK

Before considering the redesign complete, review the entire experience as a senior SaaS product designer.

Check:

* Does Profitina look premium?
* Does it look like a real product?
* Does it feel Nigerian without looking stereotypically Nigerian?
* Is accounting easy to understand?
* Is AI genuinely useful?
* Is automation visible?
* Are invoices easy to manage?
* Are reminders easy to configure?
* Is inventory intuitive?
* Are financial reports professional?
* Is the dashboard useful?
* Is the interface responsive?
* Is the typography consistent?
* Are spacing and alignment consistent?
* Are tables readable?
* Are actions obvious?
* Are empty states helpful?
* Are financial actions protected by confirmation?
* Does the website convert visitors into users?

Most importantly:

**DO NOT make it look like an AI-generated SaaS template.**

The product should feel deliberately designed by a world-class fintech product team.

The final impression should be:

# PROFITINA

**Know Your Numbers. Grow Your Business.**

**AI-powered accounting and business finance for Nigerian businesses.**

</pasted_text>

## Assistant



## Assistant

This brief is a full product evolution — new brand, ~10 new modules, AI + automation layers, and a marketing site. Too much for one pass at real quality, so I need to know what to build first and settle two calls the brief leaves open.

_[tool: ask_user]_

_[tool: ask_user]_

Form's up — waiting on the build order, which modules must be real in this pass, and the type/accent calls before I start.

## User

Answered — Asked Claude to decide; first_pass: The app: rebrand, new sidebar IA, new dashboard, AI insights + assistant; mobile: Responsive now

## Assistant

_[tool: run_script]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

Building the rebrand pass: brand, type, palette, new IA, then the dashboard and Ask Profitina.

_[tool: run_script]_

_[tool: run_script]_

_[tool: run_script]_

_[tool: show_html]_

_[tool: read_file]_

_[tool: run_script]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: run_script]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: run_script]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: run_script]_

_[tool: ready_for_verification]_

_[tool: set_project_title]_

Pass one is in: **Profitina** app shell, new IA, dashboard, and the AI layer.

**Calls I made for you** (you left them to me): Familjen Grotesk throughout with IBM Plex Mono for all figures — no serif, no Inter; growth green `#0B6B4F` (lighter `#3F9273` on charcoal) used only in deltas, primary CTAs and the active nav bar; amber kept strictly for warnings and the trial pill; church mode retained as a business type; accountant multi-business deferred to the next pass.

**What's new**
- **IA** regrouped to Overview / Sales / Purchases / Inventory / Accounting / Workspace, with Ask Profitina alongside Dashboard. Every nav item leads to a real screen — nothing stubbed.
- **Dashboard** opens with "Good morning, Tosin", the date, and the subhead; four metric cards (Revenue, Expenses, Profit/Loss, Cash Balance); then **Profitina Intelligence** on charcoal — four insights computed from the actual ledger (margin movement, overdue collections, cash runway, best product), each with a real action plus Ask Profitina; and a **Business health** score, 84/100 across five weighted components.
- **Profitina AI** answers six questions off the real data with figures, a row table, totals and suggested actions. Bulk sends route through an approval dialog first — "Approve 2 payment reminders", channel listed, explicitly labelled as not connected.
- Sample data reseeded to Mideops Ventures with Prime Foods, Bella Fashion House, Delta Fresh Mart, Warri Tech Solutions, Lagos Home Supplies, Chinedu Okafor.
- Responsive: sidebar becomes a horizontal nav strip under 900px; main content holds beside the sidebar down to ~620px.

Two caveats: the file is still named `Ledgerly.dc.html` — say the word and I'll rename it. And the landing page, Automation builder, Tax Center, Payroll and command palette are untouched, per your "app first" answer.

## User

Found issues — fixing…

## User

Found issues — fixing…

## User

Update the color scheme to a black-and-gold palette:
- Primary dark surface (sidebar, header, dark UI chrome): #1a1a1a (near-black charcoal)
- Primary accent (buttons, active nav states, highlights, links): #FAC775 (warm gold — not a bright caution yellow)
- Accent text on dark surfaces: #FAC775
- Accent text on light gold backgrounds: #412402 (dark brown, for contrast/readability)
- Light gold background fills (status banners, badges, subtle highlights): #FAEEDA
- Keep all other surfaces neutral (white/light gray backgrounds, standard dark gray body text) so the black-and-gold only appears in navigation, primary actions, and accent moments — not flooding every screen.

Apply this to: sidebar/navigation, primary buttons, active states, key metric highlights, and status banners (e.g. tax compliance notices). Body text, tables, and form fields should stay on neutral light surfaces for readability. Maintain WCAG-acceptable contrast everywhere text sits on a colored background. Add a Profitna logo and apply it consistently across the app:

Icon mark: a rounded square (26px corner radius) filled #1a1a1a, containing a bold letter "P" centered in #FAC775, sized so the icon reads clearly at both 32px (sidebar/nav) and favicon-scale sizes.

Wordmark: "Profitna" in a medium-weight sans-serif, letter-spacing slightly open, in #FAC775 when on dark backgrounds (sidebar, dark headers) and #1a1a1a when on light backgrounds (light-mode headers, printed documents, email templates).

Lockup: icon mark + wordmark side by side with ~10px gap, used as the primary logo in the sidebar header, login/auth screens, and the browser tab favicon (icon mark only).

Apply the logo to: sidebar top-left, login and signup screens, loading/splash state, invoice and report PDF headers, and email notification templates. Use the icon-only mark for the favicon and any small/app-icon-sized placement.

## Assistant

_[tool: grep]_

_[tool: grep]_

_[tool: run_script]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: run_script]_

_[tool: ready_for_verification]_

Black-and-gold applied, logo in place.

**Palette** — dark chrome moved to `#1a1a1a`; gold `#FAC775` now carries the sidebar mark, active nav rail, badges, nav dots, the Intelligence panel's primary buttons, and primary-button hover states. On light surfaces gold only appears as fills (`#FAEEDA` for the trial banner, AI-suggestion block, selected import source, "Profitina suggests") with `#412402` text — that pairing clears WCAG AA at body size. Links and small accent text use `#412402`, focus rings gold at 55%. Tables, forms and body copy stayed neutral.

Semantic colour was left alone deliberately: money green and overdue red still mark positive/negative figures, aging buckets and health bars. Turning those gold would cost readability where it matters most.

**Logo** — icon mark (26% radius rounded square, `#1a1a1a`, gold "P") plus open-tracked wordmark: full lockup in the sidebar, sign-in and sign-up panels; icon-only when the sidebar collapses; icon + `#1a1a1a` wordmark at the top of every report / print header; icon-only SVG favicon so the browser tab carries the mark.

Two notes: your brief spelled the wordmark "Profitna" — I kept **Profitina** to match the rest of the product; say the word if the shorter spelling is intentional and I'll change it everywhere. And there's no splash screen or email template in this build yet, so the logo has nowhere to go there — both come with the next pass.

## User

Change the name to Profitna

## Assistant

_[tool: run_script]_

_[tool: delete_file]_

_[tool: ready_for_verification]_

Renamed to **Profitna** everywhere — wordmark, page title, sidebar, AI assistant name and copy, sign-in panel, suggestion labels — and the file is now `Profitna.dc.html`.

## User

Design the Profitna logo as a wordmark with an integrated tick mark:

Wordmark: "PROFIT" in #1a1a1a (black), directly followed by "NA" in gold, set in a bold sans-serif with wide letter-spacing, all uppercase.

Tick mark: a small angular upward-trending line (like a stock/growth chart tick) positioned just after the wordmark, in the same gold as "NA."

Provide two versions:
1. Light version — on a white/light background, use #997315 (a deeper, muted gold) for "NA" and the tick mark, since the brighter gold doesn't have enough contrast against white to stay legible. "PROFIT" stays #1a1a1a.
2. Dark version — on a #1a1a1a background, use the full bright #FAC775 gold for "NA" and the tick mark. "PROFIT" becomes #FAEEDA (off-white) for readability.

Also produce:
- A standalone icon/favicon variant using just the tick mark shape inside a rounded square or circle badge (black background, gold tick), for use as an app icon.
- Confirm both wordmark versions meet accessible contrast standards against their backgrounds.

Style: clean, flat, bold, no gradients or drop shadows. Confident and modern — should read as a serious fintech/accounting brand.

## Assistant

_[tool: grep]_

_[tool: run_script]_

_[tool: run_script]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: multi_screenshot]_

_[tool: ready_for_verification]_

Wordmark logo built and applied.

**Mark** — "PROFIT" + "NA" in bold uppercase at 0.09em tracking, with the tick set just after it: a three-segment angular climb ending in a filled arrowhead, flat, no gradients, aligned to the cap height so the lockup reads as one object.

**Where it lands** — dark version on the sign-in and sign-up panels and the sidebar header; light version centred at the top of every report/print header; tick-only badge as the favicon and the app icon. When the sidebar collapses, the rail keeps just the gold tick — a `#1a1a1a` badge would be invisible on the `#1a1a1a` sidebar, so the tick stands alone there.

**Contrast** (measured, not estimated):
- Light: `#1a1a1a` on white 17.4:1 (AAA). `#997315` on white 4.36:1 — clears AA for large bold type and for graphics (3:1), and sits just under the 4.5:1 body-text bar. If you ever need "NA" at small sizes, `#8A6712` gets you 5.2:1 with no perceptible hue shift.
- Dark: `#FAEEDA` on `#1a1a1a` 15.2:1, `#FAC775` on `#1a1a1a` 11.2:1 — both AAA at any size. Icon tick 11.2:1.

All three assets are also laid out in Settings → Brand assets with their ratios, so the numbers travel with the file.

