# Deploying Profitna

Profitna is a Node server plus a Postgres database, so it cannot be uploaded to
shared hosting the way a static site can. Two supported ways to run it:

- **[Render](#render)** — connect the repository, it builds and runs both
  pieces for you. No server to maintain. This is the path to take unless you
  want your own box.
- **[A VPS](#a-vps)** — Postgres, the app and Caddy as three containers on one
  machine you own and maintain.

Everything below assumes the domain `profitna.com`. Substitute your own.

---

<a id="render"></a>

## Render

`render.yaml` in this repository defines the whole thing: a web service built
from the `Dockerfile`, and a managed Postgres wired into it. The app serves
both the API and the interface, so one service is all it needs.

### 1. Create the services

In Render: **New → Blueprint**, connect this repository, and select the
`backend-for-profitna` branch. It reads `render.yaml` and creates the web
service and the database. `JWT_SECRET` is generated for you; `DATABASE_URL` is
wired from the database automatically.

Check the plans it proposes before approving — pricing and free-tier terms
change, and a free instance that sleeps when idle will make the first visit of
the day slow. Migrations run on every deploy, before the app accepts traffic.

Watch the first deploy's logs: you want the migration output, then
`Profitna server listening`, then a healthy status against `/api/health`.

### 2. Point the domain at it

In the Render service → **Settings → Custom Domains**, add `profitna.com` and
`www.profitna.com`. Render shows the exact DNS records to create.

Then in hPanel → **Domains → profitna.com → DNS Zone**, delete the existing
parking records — the `A`/`AAAA` entries on `@` and the `www` CNAME pointing at
`hstgr.net` — and add what Render gave you (typically an `ALIAS`/`ANAME` or `A`
for the apex, and a `CNAME` for `www`). Delete the `AAAA` records unless Render
gave you an IPv6 target: browsers prefer IPv6, and a stale AAAA makes a working
site look down.

Certificates are issued automatically once DNS resolves, usually within
minutes.

### 3. First account

Open `https://profitna.com` and create the account — it becomes the admin of
its organisation. The books start **empty** by design; `SEED_DEMO_DATA` is
deliberately not set, so you get the designed empty states rather than
somebody else's sample data. To demo with populated books instead, add
`SEED_DEMO_DATA=true` in the Render dashboard, redeploy, and create a *new*
account — then remove it before real customers sign up.

### Afterwards

Pushing to `backend-for-profitna` redeploys. Render backs the database up on
paid plans; confirm what your plan actually retains rather than assuming.

---

<a id="a-vps"></a>

## A VPS

Three containers on one machine: Postgres, the app, and Caddy, which gets the
HTTPS certificate and renews it.

### The short version

On a VPS that already has the DNS records from step 2 pointing at it:

```bash
git clone -b backend-for-profitna git@github.com:tosynogunniyi-ux/claude.git /opt/profitna
cd /opt/profitna
bash deploy/bootstrap.sh profitna.com
```

`deploy/bootstrap.sh` installs Docker if it is missing, refuses to start while
something else holds ports 80/443, checks the domain actually resolves to this
server before Caddy asks for a certificate, generates the database password and
session secret into `.env`, then builds and starts everything and waits for the
app to report healthy. It is safe to re-run — it never overwrites an existing
`.env` and never touches the database volume.

The rest of this document is the same thing step by step, which is what you
want when something needs diagnosing.

---

### 1. Create the VPS

In hPanel → **VPS** → create an instance. The smallest plan (1 vCPU / 4 GB) is
comfortable for this. Choose the **Ubuntu 24.04 with Docker** template so Docker
and the compose plugin are already installed, set a root password or SSH key,
and note the **IPv4 address** it gives you — call it `VPS_IP` below.

If you pick a plain Ubuntu template instead, install Docker first:

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Point the domain at it

`profitna.com` currently resolves to Hostinger's parking infrastructure
(`orbit.dns-parking.com` / `horizon.dns-parking.com`, with `www` pointing at
`www.profitna.com.cdn.hstgr.net`). Those records have to be replaced, or the
domain will keep serving the parked page.

In hPanel → **Domains → profitna.com → DNS / Nameservers → DNS Zone**:

| Action | Type | Name | Value | TTL |
|---|---|---|---|---|
| Delete | A / AAAA | `@` | the existing parking addresses | — |
| Delete | CNAME | `www` | `www.profitna.com.cdn.hstgr.net` | — |
| Add | A | `@` | `VPS_IP` | 300 |
| Add | A | `www` | `VPS_IP` | 300 |

Delete the AAAA records too unless you are giving the VPS an IPv6 address —
a stale AAAA record wins over a working A record in most browsers and the site
will look down.

If the domain is attached to a shared hosting plan in hPanel, detach it there
as well, or Hostinger may keep managing these records and overwrite them.

Check it has taken effect before going further:

```bash
dig +short profitna.com        # expect VPS_IP
dig +short www.profitna.com    # expect VPS_IP
```

Propagation is usually minutes at TTL 300. **Do not start Caddy until this
resolves** — Let's Encrypt validates over the live domain, and repeated
failures hit a rate limit that locks you out for an hour.

### 3. Open the firewall

Ports 80 and 443 must reach the box: check hPanel → VPS → **Firewall**, and on
the server itself:

```bash
ufw allow 22,80,443/tcp && ufw --force enable
```

### 4. Get the code onto the server

The repository is private, so give the VPS its own read-only deploy key:

```bash
ssh root@VPS_IP
ssh-keygen -t ed25519 -C "profitna-vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that key into GitHub → the repo → **Settings → Deploy keys → Add deploy
key** (read access is enough), then:

```bash
git clone -b backend-for-profitna git@github.com:tosynogunniyi-ux/claude.git /opt/profitna
cd /opt/profitna
```

### 5. Configure secrets

```bash
cp .env.deploy.example .env
nano .env
```

Fill in three values — the rest can stay empty and their features stay off:

```
SITE_DOMAIN=profitna.com
POSTGRES_PASSWORD=   # openssl rand -base64 24
JWT_SECRET=          # openssl rand -hex 48
```

`.env` is gitignored. Keep it off your laptop and out of screenshots; changing
`JWT_SECRET` later signs every user out.

### 6. Start it

```bash
docker compose up -d --build
docker compose ps          # all three services "running", db "healthy"
docker compose logs -f app # migrations run, then "listening on ..."
```

The app container runs `node src/migrate.js` before starting, so the schema is
created on first boot and updated on every deploy.

Confirm from the server, then from your own browser:

```bash
curl -s localhost:4000/api/health   # {"ok":true} — bypasses Caddy
curl -sI https://profitna.com/      # 200, after the certificate is issued
```

First HTTPS request can take a few seconds while Caddy gets the certificate.
`docker compose logs caddy` shows the issuance and any DNS problem plainly.

### 7. First account

Open `https://profitna.com`, create the account, and it becomes the admin of
its organisation. The books start **empty** — `SEED_DEMO_DATA` is deliberately
not set in production, so you get the designed empty states rather than
somebody else's sample data.

To show the populated demo instead, uncomment `SEED_DEMO_DATA: "true"` in
`docker-compose.yml`, `docker compose up -d`, and create a *new* account.
Turn it back off before real customers sign up.

---

## Running it afterwards

**Deploy a change**

```bash
cd /opt/profitna && git pull && docker compose up -d --build
```

**Back up the database** — do this before you have customers, not after:

```bash
docker compose exec -T db pg_dump -U profitna profitna | gzip > profitna-$(date +%F).sql.gz
```

Put that in a daily cron job and copy the file off the box. A VPS is a single
machine; if it fails, only what you have copied elsewhere survives.

**Restore**

```bash
gunzip -c profitna-2026-09-15.sql.gz | docker compose exec -T db psql -U profitna profitna
```

**Watch logs**: `docker compose logs -f app`

## Before real customers use it

- **Payments** — add `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`, then
  schedule the charge at trial end; `chargeDue()` in
  `server/src/routes/subscription.js` does the charging but nothing calls it
  yet. Point the Paystack webhook at `https://profitna.com/api/webhooks/paystack`.
- **Google sign-in** — add `GOOGLE_CLIENT_ID` and list
  `https://profitna.com` as an authorised origin in the Google console.
- **Bank feeds** — add `MONO_SECRET_KEY` and `MONO_WEBHOOK_SECRET`; the widget
  still needs adding to the front end.
- **Roles** — the API enforces admin / accountant / viewer, but the UI does not
  yet hide what a viewer cannot do, and there is no invite flow, so treat every
  account as an owner for now.

## A caveat worth stating plainly

The application has been tested end to end — signup, the ledger, invoices and
payments, inventory, statement import, reports, and tenant isolation — but the
**Docker image has never been built or run anywhere**. The session that wrote
these files could not reach Docker Hub to pull a base image. Both paths above
build that same `Dockerfile`, so expect to shake out a small issue or two on
the first build, in Render's deploy log or in `docker compose logs`. It is the
kind of problem that is quick to fix once the log says what it is.

One known difference between the two: Render's Postgres may require TLS on the
connection. If the first deploy fails with an SSL or `pg_hba.conf` error, add
`PGSSL=require` to the service's environment and redeploy — `server/src/db.js`
reads it.
