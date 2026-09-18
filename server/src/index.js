require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requireAuth } = require('./auth');
const authRoutes = require('./routes/auth');
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
app.get('/support.js', (req, res) => res.sendFile(path.join(WEB_ROOT, 'support.js')));
app.use('/vendor', express.static(path.join(WEB_ROOT, 'vendor'), { maxAge: '1y', index: false }));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 4000;
  app.listen(port, () => console.log('Profitna server listening on http://localhost:' + port));
}

module.exports = app;
