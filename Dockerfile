# Build context is the repository root: the server serves the front end from
# ../../web, so both directories have to be in the image.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code change doesn't reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY web/Profitna.dc.html web/support.js ./web/
COPY web/vendor ./web/vendor

# Runs unprivileged; node:alpine ships a "node" user for exactly this.
RUN chown -R node:node /app
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "src/index.js"]
