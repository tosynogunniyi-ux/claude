const express = require('express');
const { many, one, query, tx: transaction } = require('../db');
const { requireOrg, audit } = require('../auth');
const shape = require('../shape');

const router = express.Router({ mergeParams: true });

const DAY = 86400000;

// Same rule the prototype used: same amount, same direction, within three days.
router.post('/bank/auto-match', requireOrg('accountant'), async (req, res, next) => {
  try {
    const [lines, ledger] = await Promise.all([
      many('SELECT * FROM bank_statement_lines WHERE organization_id = $1 AND matched_transaction_id IS NULL', [req.orgId]),
      many('SELECT * FROM transactions WHERE organization_id = $1', [req.orgId])
    ]);

    const taken = new Set(
      (await many('SELECT matched_transaction_id FROM bank_statement_lines WHERE organization_id = $1 AND matched_transaction_id IS NOT NULL', [req.orgId]))
        .map((r) => r.matched_transaction_id)
    );

    const matched = [];
    for (const line of lines) {
      const want = Math.abs(line.amount);
      const hit = ledger.find((t) =>
        !taken.has(t.id) &&
        Math.abs(t.amount - want) < 1 &&
        Math.abs(new Date(t.date) - new Date(line.date)) <= 3 * DAY &&
        (line.amount < 0) === (t.type === 'expense')
      );
      if (!hit) continue;
      taken.add(hit.id);
      const row = await one(
        'UPDATE bank_statement_lines SET matched_transaction_id = $3 WHERE organization_id = $1 AND id = $2 RETURNING *',
        [req.orgId, line.id, hit.id]
      );
      matched.push(shape.bankShape(row));
    }

    await audit(req.orgId, req.user.id, 'bank.auto_matched', 'bank_statement_line', null, { count: matched.length });
    res.json({ matched, count: matched.length, total: lines.length });
  } catch (err) {
    next(err);
  }
});

router.post('/bank/:lineId/match', requireOrg('accountant'), async (req, res, next) => {
  try {
    const txId = (req.body || {}).transactionId || null;
    if (txId) {
      const owned = await one('SELECT id FROM transactions WHERE organization_id = $1 AND id = $2', [req.orgId, txId]);
      if (!owned) return res.status(404).json({ error: 'No such transaction.' });
    }
    const row = await one(
      'UPDATE bank_statement_lines SET matched_transaction_id = $3 WHERE organization_id = $1 AND id = $2 RETURNING *',
      [req.orgId, req.params.lineId, txId]
    );
    if (!row) return res.status(404).json({ error: 'No such statement line.' });
    res.json({ line: shape.bankShape(row) });
  } catch (err) {
    next(err);
  }
});

// Posts a reviewed statement import: each row becomes a transaction and a
// statement line already marked reconciled against it.
router.post('/bank/import', requireOrg('accountant'), async (req, res, next) => {
  try {
    const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'There are no rows to post.' });

    const result = await transaction(async (client) => {
      const created = { tx: [], bank: [] };
      for (const r of rows) {
        const amount = Math.abs(Number(r.amount) || 0);
        if (!amount) continue;
        const type = r.type === 'income' ? 'income' : 'expense';

        const ledger = (await client.query(
          `INSERT INTO transactions
             (organization_id, type, date, amount, category, fund, party, description, method, source, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'import', $10) RETURNING *`,
          [
            req.orgId, type, r.date, amount, String(r.category || ''), r.fund || null,
            String(r.party || ''), String(r.description || r.narration || ''),
            'Bank transfer', req.user.id
          ]
        )).rows[0];

        const line = (await client.query(
          `INSERT INTO bank_statement_lines
             (organization_id, date, narration, amount, matched_transaction_id, source)
           VALUES ($1, $2, $3, $4, $5, 'import') RETURNING *`,
          [req.orgId, r.date, String(r.narration || r.description || ''), type === 'expense' ? -amount : amount, ledger.id]
        )).rows[0];

        created.tx.push(shape.txShape(ledger));
        created.bank.push(shape.bankShape(line));
      }
      return created;
    });

    await audit(req.orgId, req.user.id, 'bank.statement_imported', 'bank_statement_line', null, { count: result.tx.length });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------- Mono bank feed ----------------
// Mono (part of Flutterwave since 2026) handles the customer's bank login on
// their side; this server only ever sees an account id and the transactions
// synced against it. Okra is defunct — do not integrate it.

router.post('/bank/connect', requireOrg('admin'), async (req, res, next) => {
  try {
    if (!process.env.MONO_SECRET_KEY) {
      return res.status(501).json({ error: 'Bank feeds are not configured on this server.' });
    }
    const code = String((req.body || {}).code || '');
    if (!code) return res.status(400).json({ error: 'Missing the Mono authorisation code.' });

    const exchange = await fetch('https://api.withmono.com/v2/accounts/auth', {
      method: 'POST',
      headers: { 'mono-sec-key': process.env.MONO_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!exchange.ok) return res.status(502).json({ error: 'Mono rejected that authorisation code.' });
    const body = await exchange.json();
    const accountId = body && body.data && body.data.id;
    if (!accountId) return res.status(502).json({ error: 'Mono did not return an account id.' });

    const row = await one(
      `INSERT INTO bank_connections (organization_id, provider, provider_account_id, institution_name)
       VALUES ($1, 'mono', $2, $3)
       ON CONFLICT (organization_id, provider_account_id) DO UPDATE SET status = 'active'
       RETURNING *`,
      [req.orgId, accountId, (req.body || {}).institution || null]
    );
    await audit(req.orgId, req.user.id, 'bank.connected', 'bank_connection', row.id);
    res.status(201).json({ connection: { id: row.id, institution: row.institution_name, status: row.status } });
  } catch (err) {
    next(err);
  }
});

// Public endpoint: Mono posts here. Authentication is the shared webhook
// secret, so it is mounted outside the org-scoped router.
async function monoWebhook(req, res, next) {
  try {
    if (!process.env.MONO_WEBHOOK_SECRET) return res.status(501).end();
    if (req.get('mono-webhook-secret') !== process.env.MONO_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Bad signature.' });
    }

    const event = req.body || {};
    const accountId = event.data && (event.data.account || event.data._id);
    const connection = accountId
      ? await one("SELECT * FROM bank_connections WHERE provider_account_id = $1 AND status = 'active'", [String(accountId)])
      : null;
    if (!connection) return res.json({ ok: true });

    const entries = Array.isArray(event.data.transactions) ? event.data.transactions : [];
    for (const t of entries) {
      const amount = (Number(t.amount) || 0) / 100;
      await query(
        `INSERT INTO bank_statement_lines
           (organization_id, bank_connection_id, provider_transaction_id, date, narration, amount, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'feed')
         ON CONFLICT (bank_connection_id, provider_transaction_id) DO NOTHING`,
        [
          connection.organization_id, connection.id, String(t._id || t.id),
          String(t.date || '').slice(0, 10),
          t.narration || t.description || '',
          t.type === 'debit' ? -amount : amount
        ]
      );
    }
    await query('UPDATE bank_connections SET last_synced_at = now() WHERE id = $1', [connection.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { router, monoWebhook };
