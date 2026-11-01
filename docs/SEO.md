# Being found

Profitna's public pages are at `/`, `/features`, `/pricing`, the three
`/solutions/*` pages, `/about`, `/security`, `/resources` and `/contact`. They
are plain HTML built on the server (`server/src/marketing/`), so a crawler that
runs no JavaScript still reads every word. The application lives at `/app` and
is deliberately kept out of all of this.

Everything below is a setting, not a code change. Nothing here needs a deploy
except pasting the variables into Easypanel and restarting.

## 1. Check what is already true

    curl -s https://profitna.com/api/health | python3 -m json.tool

The `analytics` block answers all of it:

    "analytics": {
      "state": "off",                       off | on | misconfigured
      "measurement": null,                  the G- id, once it is set
      "consent": "denied until the visitor accepts",
      "searchConsole": "not claimed",
      "bing": "not claimed",
      "events": ["start_trial_click", "sign_in_click", "contact_email_click"],
      "warnings": []
    }

`misconfigured` means `GA4_MEASUREMENT_ID` is set to something that is not a
measurement id — usually a Google Tag id (`GT-`) or a property number. Nothing
is loaded while it says that, and `warnings` says what to fix.

## 2. Google Search Console

1. <https://search.google.com/search-console> → **Add property** → **URL
   prefix** → `https://profitna.com`.
2. Choose **HTML tag** verification. It shows
   `<meta name="google-site-verification" content="LONG-STRING">`.
3. Copy **only** `LONG-STRING` into `GOOGLE_SITE_VERIFICATION` in Easypanel,
   and restart the service.
4. Back in Search Console, press **Verify**.
5. **Sitemaps** → submit `sitemap.xml`.
6. **URL inspection** → paste `https://profitna.com/` → **Request indexing**.
   Do the same for `/pricing` and `/features`.

Two days later, **Performance** starts showing the queries people typed. That
list is the most useful page on this list: it says what to write next.

## 3. Bing Webmaster Tools

1. <https://www.bing.com/webmasters> → **Add site**.
2. You can import from Search Console in one click, or verify with the meta
   tag: copy its content value into `BING_SITE_VERIFICATION` and restart.
3. Submit `https://profitna.com/sitemap.xml`.

Worth doing even though Bing is small here: several AI assistants answer from
Bing's index.

## 4. Google Analytics 4

1. <https://analytics.google.com> → **Admin** → **Create** → property, Nigeria,
   NGN.
2. **Data streams** → **Web** → `https://profitna.com`. Copy the measurement
   id, `G-XXXXXXXXXX`.
3. Put it in `GA4_MEASUREMENT_ID` in Easypanel and restart.
4. Check `/api/health` says `"state": "on"`.

What then happens in a visitor's browser:

- the tag loads with `ad_storage`, `ad_user_data`, `ad_personalization` and
  `analytics_storage` **denied**, so nothing is written;
- a bar appears at the foot of the page offering the choice;
- **Allow** writes `profitna_ads=on` — the same cookie the application and the
  privacy notice already use — and consent is granted;
- **No thanks** writes `profitna_ads=off` and the tag stays denied for six
  months.

One answer governs Google Analytics, the Meta pixel and the server-side Meta
reporting alike.

## 5. Mark the conversions

Three events are sent, all of them a click on a link the page already has:

| Event | Fired by |
|---|---|
| `start_trial_click` | any **Start free trial** button (they all point at `/app?start=1`) |
| `sign_in_click` | **Sign in** |
| `contact_email_click` | a `mailto:` link, on `/contact` and in the footer |

In GA4: **Admin** → **Events** → find `start_trial_click` after the first few
have arrived → toggle **Mark as key event**. Do the same for the other two if
you want them counted.

A signup *completing* happens inside the application, which is not measured.
If that number is ever wanted, the honest way to get it is from our own
database — `SELECT date_trunc('day', created_at), count(*) FROM organizations` —
not by putting Google inside the product.

## 6. What is deliberately not here

- No Google Tag Manager. One tag, in the page, readable.
- No analytics inside `/app`. Nothing Google loads can see a figure in anyone's
  books.
- No session recording, scroll tracking or form instrumentation.
- No claims on the public pages that the software cannot back up: no reviews,
  no awards, no certifications, no customer counts, and no feature that is
  switched off in production.

## 7. Structured data

Every public page carries JSON-LD (`server/src/marketing/render.js`):
`Organization`, `WebSite`, the page itself, a `BreadcrumbList`, and on the
home, features and pricing pages a `SoftwareApplication` whose two `Offer`s
read their figures from `server/src/pricing.js` — the same module the paywall
charges from, so the markup cannot drift from the price. The home and pricing
pages also carry a `FAQPage` built from the same array the page renders, so
the marked-up answers are always the answers a visitor can see.

Check it with <https://validator.schema.org> or Search Console's **Rich
results test**.

## 8. If a page stops being indexed

In order:

1. `curl -sI https://profitna.com/<path>` — is it 200?
2. `curl -s https://profitna.com/robots.txt` — is it disallowed?
3. `curl -s https://profitna.com/<path> | grep -i 'name="robots"'` — it should
   say `index,follow`.
4. Search Console → **Pages** → the reason is named there.
5. `npm run test:marketing` — 151 checks that answer most of the above
   mechanically.
