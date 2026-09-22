require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requireAuth } = require('./auth');
const { gate } = require('./admin-auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const orgRoutes = require('./routes/org');
const ledgerRoutes = require('./routes/ledger');
const bankRoutes = require('./routes/bank');
const subscriptionRoutes = require('./routes/subscription');

const app = express();
app.set('trust proxy', 1);

// Webhooks verify a signature over the exact bytes received, so they are
// mounted before the JSON parser can rewrite the body.
app.post('/api/webhooks/paystack', express.raw({ type: '*/*' }), subscriptionRoutes.paystackWebhook);
app.post('/api/webhooks/mono', express.json(), bankRoutes.monoWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes.router);

// The platform owner's console. `gate` answers 404 — not 401 — when no owner
// account exists or the caller is outside ADMIN_IP_ALLOWLIST, so a deployment
// that has not run create-admin advertises nothing to probe at.
app.use('/api/admin', gate, adminRoutes.router);

const orgScoped = express.Router({ mergeParams: true });
orgScoped.use(orgRoutes.router);
orgScoped.use(ledgerRoutes.router);
orgScoped.use(bankRoutes.router);
orgScoped.use(subscriptionRoutes.router);
app.use('/api/orgs/:orgId', requireAuth, orgScoped);

// The prototype is served from here, so the API is same-origin and the session
// cookie needs no cross-site relaxation.
// Only the files the app is actually made of are served.
const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
app.get('/', (req, res) => res.sendFile(path.join(WEB_ROOT, 'Profitna.dc.html')));

// Nothing in the product links here, and the path can be moved somewhere
// unguessable with ADMIN_PATH. That is obscurity, not security — the console
// is protected by the credentials behind it — but it keeps the login form out
// of the way of people who have no business finding it.
const ADMIN_PATH = (process.env.ADMIN_PATH || '/admin').replace(/\/+$/, '') || '/admin';
app.get(ADMIN_PATH.startsWith('/') ? ADMIN_PATH : '/' + ADMIN_PATH, gate, (req, res) =>
  res.sendFile(path.join(WEB_ROOT, 'admin.html'))
);
app.get('/support.js', (req, res) => res.sendFile(path.join(WEB_ROOT, 'support.js')));
app.use('/vendor', express.static(path.join(WEB_ROOT, 'vendor'), { maxAge: '1y', index: false }));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

if (require.main === module) {
  // Fail at boot rather than at the first sign-in attempt: a missing secret is
  // a deployment mistake, and it is far cheaper to find in the startup log.
  for (const required of ['DATABASE_URL', 'JWT_SECRET']) {
    if (!process.env[required]) {
      console.error(required + ' is not set — refusing to start. See server/README.md.');
      process.exit(1);
    }
  }

  const port = Number(process.env.PORT) || 4000;
  // Binds all interfaces so a reverse proxy in another container can reach it.
  app.listen(port, '0.0.0.0', () => {
    console.log('Profitna server listening on port ' + port);
    console.log('If your proxy targets a different port, set PORT to match it.');
  });
}

module.exports = app;
