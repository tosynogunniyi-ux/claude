# Build context is the repository root: the server serves the front end from
# ../../web, so both directories have to be in the image.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# pg_dump and pg_restore for the nightly backup.
#
# 16 first, to match the database. A newer client can dump an older server, so
# the unpinned package is a safe fallback if Alpine renames or moves on; an
# older client cannot, which is why 16 is asked for first.
#
# Deliberately not fatal. This app is taking real payments, and breaking a
# deployment because a package name moved would be a far worse outcome than
# backups not starting. If neither package lands, the server says so loudly at
# boot and the owner's console reports the backups as unhealthy, so it cannot
# fail quietly instead.
RUN apk add --no-cache postgresql16-client \
 || apk add --no-cache postgresql-client \
 || echo "WARNING: no postgresql client in this image; nightly backups will not run"

# Dependencies first, so a code change doesn't reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY web/Profitna.dc.html web/support.js web/admin.html ./web/
COPY web/vendor ./web/vendor

# Somewhere to write dumps, owned by the user that writes them. A host that
# mounts a volume over this path must give it to uid 1000, or the backup will
# say so at boot rather than at 2am.
RUN mkdir -p /data/backups

# Runs unprivileged; node:alpine ships a "node" user for exactly this.
RUN chown -R node:node /app /data
USER node

ENV PORT=4000
EXPOSE 4000

# Follows PORT, so a host that routes to a different port (Easypanel defaults
# to 3000) does not end up with a working app reporting itself unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server

# Migrations run before the server starts, as part of the image's own default
# command. A host that cannot express a custom start command — or an operator
# who forgets to set one — still gets a schema that matches the code, and the
# server refuses to start if they fail.
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
