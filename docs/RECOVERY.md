# When the server is unreachable

Written during the outage of 18 October 2026, while it was still happening, so
that the next one is a procedure rather than an improvisation.

## The one rule

**Get a copy of the data off the machine before anyone does anything
irreversible to it.**

Everything else can be rebuilt from the repository in under an hour. The
database cannot. Support's standard fix for a VPS that will not respond is to
reinstall the operating system, and that destroys the disk — including the
nightly dumps, because they live on the same disk as the database they are
dumps of. When you open a ticket, say in the first message that the disk must
be preserved.

## What is safe, and what is not

| | Where it lives | Survives losing the VPS? |
|---|---|---|
| All application code | GitHub, `main` | **Yes** |
| The schema and migrations | GitHub | **Yes** |
| Customer books, invoices, payroll | Postgres on the VPS | **No** |
| Nightly dumps | `/data/backups` on the same VPS | **No** |
| Environment variables | Easypanel on the VPS | **No**, but see below |
| Uploaded logos | Postgres (`organizations.logo`) | With the database |

Losing the environment variables is survivable. `JWT_SECRET` can be replaced —
everyone is signed out once and signs back in. The database password can be
replaced, because a restore loads a plain SQL dump into a fresh database. The
SMTP and Monnify values are retrievable from Hostinger and Monnify. Nothing in
that list is unrecoverable; only the database is.

`CREDENTIALS_KEY` is the exception, and it is not set yet. Once it is, it must
be recorded somewhere off the machine, because credentials encrypted with it
can only be read with it.

## If the machine comes back

Do this **first**, before looking at whether the site works:

```bash
docker compose exec -T db pg_dump -U profitna profitna | gzip > profitna-$(date +%F).sql.gz
```

Then copy it to your own computer:

```bash
scp root@SERVER_IP:/root/profitna-$(date +%F).sql.gz .
```

Only then start diagnosing. A machine that has just come back from an
unexplained outage may go away again.

Then set `BACKUP_S3_*` in Easypanel. The code already copies each verified
dump off-site as soon as it is taken; it only needs somewhere to put it.

## If the machine does not come back

Ask Hostinger for **recovery mode** — it boots a rescue system with your disk
mounted but nothing running on it. From there:

```bash
# Find the Postgres volume. Under Docker it is usually here:
ls /mnt/.../var/lib/docker/volumes/

# The nightly dumps, if any completed:
ls -la /mnt/.../data/backups/
```

Copy anything you find out before touching the disk further. A dump is the
easiest thing to restore; the raw volume is recoverable too, but needs a
Postgres of the same major version to read it.

## Rebuilding somewhere else

1. New VPS, Docker installed.
2. `git clone` the repository, which has everything.
3. Write a new `.env` (see `server/.env.example`).
4. `docker compose up -d db`, then restore:
   ```bash
   gunzip -c profitna-2026-10-18.sql.gz | docker compose exec -T db psql -U profitna profitna
   ```
5. `docker compose up -d` — migrations run before the server starts, so a dump
   from an older schema is brought up to date automatically.
6. Point the `A` records for `@` and `www` at the new IP, TTL 300 — then
   add **both** hostnames to the proxy. On Easypanel: the app service →
   Domains, HTTPS on, path `/`, port `4000`. DNS alone is not enough; the
   proxy answers only for hostnames it has been given, and a missing one
   shows as a certificate warning rather than anything that names itself.
7. Check `https://profitna.com/api/health`.

## What this outage should change

- **Off-site backups are not optional for an accounting product.** One machine
  holding both the database and its backups is one machine away from losing a
  customer's books.
- **Record the environment variables somewhere off the machine** as they are
  set, not after.
- A monitor that pings `/api/health` every few minutes would have said the
  site was down before a person noticed.
