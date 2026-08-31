# Website deployment guide

_Started 2026-08-25 14:15 UTC_

---

## User

Continuing from "Design sweep and authenticity".

## Assistant

We've been rebuilding **Profitna** — an accounting app for Nigerian SMEs, churches and NGOs — from a flat, low-trust interface into a fintech-grade product with a strong black-and-gold identity and real AI features.

**Decisions made:**
- Rebranded from Ledgerly to Profitna; restructured the IA into Overview / Sales / Purchases / Inventory / Accounting / Workspace plus Ask Profitna.
- Palette: `#1a1a1a` near-black for dark chrome (sidebar, headers), `#FAC775` bright gold on dark surfaces, `#997315` muted gold on light backgrounds for contrast, `#FAEEDA` soft gold fill for banners and highlights. Semantic colours (growth green, overdue red) retained for financial data readability.
- Typography: Familjen Grotesk throughout, IBM Plex Mono for all figures.
- Logo: wordmark combining "PROFIT" in black + "NA" in gold, followed by a small angular upward-trending tick mark. Two versions — light (deeper muted gold on white) and dark (bright gold on black). Tick-only badge for favicon and collapsed sidebar rail.
- Dashboard rebuilt with hierarchy: four metric cards (Revenue, Expenses, Profit/Loss, Cash Balance), then Profitna Intelligence panel (four computed insights with actions), then Business Health score 84/100 across five weighted components.
- AI assistant (Ask Profitna) answers six questions off real ledger data with tables, totals and suggested actions; bulk sends route through approval dialogs.
- Responsive: sidebar collapses to horizontal nav strip under 900px; main content holds beside sidebar down to ~620px.

**Current state:**
All branding, IA, dashboard, AI layer, logo (three variants), and responsive layout are live end-to-end. Sign-in, sign-up, and auth flows display the dark wordmark lockup. Reports and print headers use the light version. Sample data reseeded across six fictional businesses.

**Open next steps:**
- Landing page, Automation builder, Tax Center, Payroll, command palette (deferred to next pass).
- Splash/loading screen and email notification templates (logo placement ready, awaiting template design).
- Live OAuth and payment processor wiring (from earlier pass).

**Files:**
- Profitna.dc.html (complete app, all modules, branding, AI, logo system).

## User

How best can I deploy my website on a domain?

## Assistant

Short version: Profitna is a static HTML app, so hosting is cheap and simple.

**1. Get a deployable file first.** The app currently loads `support.js` alongside it, so don't just upload `Profitna.dc.html` on its own. Either upload both files together, or I can bundle it into one self-contained HTML file that works offline — say the word and I'll do that.

**2. Pick a host.** For a static site any of these work, free tier included:
- **Netlify** or **Vercel** — drag-and-drop the folder, get a URL in a minute, add your domain in settings.
- **Cloudflare Pages** — same, plus best-in-class CDN in Africa/Nigeria latency terms.
- **GitHub Pages** — free, fine if you're already using a repo.

**3. Buy the domain.** Namecheap, Cloudflare Registrar (cheapest, no markup), or a Nigerian registrar like Whogohost/Qservers if you want a `.ng` or `.com.ng`.

**4. Point it.** In your host's dashboard add the custom domain, then at your registrar set the DNS records it gives you (usually a CNAME for `www` and an A/ALIAS for the root). HTTPS is issued automatically. Propagation is minutes to a few hours.

**One caveat:** this is a front-end prototype — the ledger data is sample data in the file, and sign-in isn't real auth. Anyone with the URL sees everything. If you're putting it in front of prospects, that's fine as a demo. Before real customers touch it you'd need a backend for accounts, data storage, and the payment/OAuth wiring still on the open list.

Want me to produce the bundled single-file version so you can upload it right away?

