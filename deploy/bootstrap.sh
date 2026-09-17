#!/usr/bin/env bash
# One-shot setup for Profitna on a fresh VPS. Safe to re-run: it never
# overwrites an existing .env and never touches the database volume.
#
#   cd /opt/profitna && bash deploy/bootstrap.sh profitna.com
#
set -euo pipefail

DOMAIN=""
PROXIED=0
for arg in "$@"; do
  case "$arg" in
    --proxied) PROXIED=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 1 ;;
    *) DOMAIN="$arg" ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  cat >&2 <<'USAGE'
usage: bash deploy/bootstrap.sh <domain> [--proxied]

  bash deploy/bootstrap.sh profitna.com
      Runs Postgres, the app, and Caddy. Caddy takes ports 80/443 and gets
      the HTTPS certificate itself.

  bash deploy/bootstrap.sh profitna.com --proxied
      For a server where CloudPanel, Plesk or your own nginx already owns
      ports 80/443. Runs Postgres and the app only, with the app on
      127.0.0.1:4000 for the panel to proxy to.
USAGE
  exit 1
fi

if [ "$PROXIED" = 1 ]; then
  COMPOSE=(docker compose -f docker-compose.proxied.yml)
else
  COMPOSE=(docker compose)
fi

cd "$(dirname "$0")/.."
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m !  %s\033[0m\n' "$1"; }
die() { printf '\033[31m x  %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- Docker ----
say "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker not found — installing it"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "The Docker compose plugin is missing. Install docker-compose-plugin and re-run."
echo "Docker $(docker --version | awk '{print $3}' | tr -d ,) ready"

# ------------------------------------------------------------ ports 80/443 --
# Hostinger VPS templates often ship with a control panel or Apache already
# bound to these ports. Caddy cannot start, and the cause is not obvious.
if [ "$PROXIED" = 1 ]; then
  say "Skipping the port check (--proxied: the panel owns 80/443)"
else
say "Checking ports 80 and 443 are free"
if command -v ss >/dev/null 2>&1; then
  BUSY="$(ss -ltnH 'sport = :80 or sport = :443' 2>/dev/null | awk '{print $4}' | tr '\n' ' ' || true)"
  if [ -n "${BUSY// /}" ]; then
    ss -ltnp 'sport = :80 or sport = :443' 2>/dev/null || true
    warn "Something is already listening on 80/443 (shown above)."
    warn "Stop it before continuing, e.g.:  systemctl disable --now apache2   (or nginx, lshttpd)"
    die "Ports are in use — Caddy cannot get a certificate while they are taken."
  fi
fi
echo "80 and 443 are free"
fi

# ------------------------------------------------------------------- DNS ----
# Let's Encrypt validates over the live domain. Starting before DNS points
# here burns failed attempts and rate-limits issuance for an hour.
if [ "$PROXIED" = 1 ]; then
  say "Checking $DOMAIN points at this server (your panel issues the certificate)"
else
  say "Checking $DOMAIN points at this server"
fi
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
echo "this server : $PUBLIC_IP"
echo "$DOMAIN -> ${RESOLVED:-(does not resolve)}"

if ! echo " $RESOLVED " | grep -q " $PUBLIC_IP "; then
  warn "$DOMAIN does not resolve to this server yet."
  warn "In hPanel -> Domains -> $DOMAIN -> DNS Zone, delete the parking A/AAAA and www CNAME records,"
  warn "then add:   A  @    $PUBLIC_IP      and   A  www  $PUBLIC_IP   (TTL 300)."
  warn "Re-run this script once 'getent ahostsv4 $DOMAIN' shows $PUBLIC_IP."
  if [ "$PROXIED" = 1 ]; then
    warn "The app itself will still start; only the certificate needs DNS in place."
  fi
  read -r -p "Continue anyway? [y/N] " go
  [ "${go:-N}" = "y" ] || exit 1
fi

if getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | grep -q ':'; then
  warn "$DOMAIN also has AAAA (IPv6) records. Unless this VPS serves IPv6, delete them —"
  warn "browsers prefer IPv6 and the site will look down while the A record is perfectly fine."
fi

# ------------------------------------------------------------------- .env ----
say "Configuring secrets"
if [ -f .env ]; then
  echo ".env already exists — leaving it untouched"
else
  cp .env.deploy.example .env
  # Generated on the server: these values never leave it and are not in git.
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
  JWT_SECRET="$(openssl rand -hex 48)"
  sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=$DOMAIN|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
  chmod 600 .env
  echo "wrote .env with a generated database password and session secret"
fi

# ------------------------------------------------------------------ start ----
say "Building and starting (first run pulls images — a few minutes)"
"${COMPOSE[@]}" up -d --build

say "Waiting for the app to report healthy"
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "app is healthy"
    break
  fi
  [ "$i" = 60 ] && { "${COMPOSE[@]}" logs --tail=40 app; die "App did not come up — logs above."; }
  sleep 2
done

say "Done"
"${COMPOSE[@]}" ps

if [ "$PROXIED" = 1 ]; then
cat <<EOF

The app is listening on 127.0.0.1:4000 — not reachable from the internet yet.
Finish in your panel:

  1. Add a site for $DOMAIN as a reverse proxy to http://127.0.0.1:4000
  2. Issue the Let's Encrypt certificate for it there

Then open  https://$DOMAIN

Logs:  docker compose -f docker-compose.proxied.yml logs -f app

Back up before you have real customers:

  docker compose -f docker-compose.proxied.yml exec -T db pg_dump -U profitna profitna | gzip > backup-\$(date +%F).sql.gz
EOF
else
cat <<EOF

Open  https://$DOMAIN

The first HTTPS request can take a few seconds while Caddy gets the
certificate. If it does not come up, look at:

    docker compose logs -f caddy      # certificate and DNS problems
    docker compose logs -f app        # application errors

The books start empty by design — create the first account and it becomes
the admin. Back up before you have real customers:

    docker compose exec -T db pg_dump -U profitna profitna | gzip > backup-\$(date +%F).sql.gz
EOF
fi
