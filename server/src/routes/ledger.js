const express = require('express');
const { many, one, query, tx: transaction } = require('../db');
const { requireOrg, audit } = require('../auth');
const shape = require('../shape');
const { byKeyword } = require('../categorize');
const banking = require('./banking');
const anthropic = require('../integrations/anthropic');

const router = express.Router({ mergeParams: true });

const amountOf = (v) => Number(String(v).replace(/[^0-9.]/g, '')) || 0;
const today = () => new Date().toISOString().slice(0, 10);

async function allowedCategories(orgId, type) {
  const rows = await many(
    type === 'income'
      ? 'SELECT name FROM income_categories WHERE organization_id = $1 ORDER BY sort_order, name'
      : 'SELECT name FROM expense_categories WHERE organization_id = $1 ORDER BY sort_order, name',
    [orgId]
  );
  return rows.map((r) => r.name);
}

// ---------------- transactions ----------------

router.post('/transactions', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    if (!b.description) return res.status(400).json({ error: 'Add a description.' });
    if (!amount) return res.status(400).json({ error: 'Add an amount.' });
    const type = b.type === 'income' ? 'income' : 'expense';
    const method = String(b.method || 'Bank transfer');

    const row = await one(
      `INSERT INTO transactions
         (organization_id, type, date, amount, category, fund, party, description, method,
          bank_account_id, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', $11)
       RETURNING *`,
      [
        req.orgId, type, b.date || today(), amount,
        String(b.category || ''), b.fund || null,
        String(b.party || ''), String(b.description || ''),
        method,
        // Which account the money moved through. Named if the entry says so,
        // otherwise the primary one for a bank method and nothing at all for
        // cash — a cash sale must not inflate a bank balance.
        await banking.resolveAccount(req.orgId, b.bankAccountId, method),
        req.user.id
      ]
    );
    await audit(req.orgId, req.user.id, 'transaction.created', 'transaction', row.id, { amount, type });
    res.status(201).json({ tx: shape.txShape(row) });
  } catch (err) {
    next(err);
  }
});

router.patch('/transactions/:id', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const current = await one('SELECT * FROM transactions WHERE organization_id = $1 AND id = $2', [req.orgId, req.params.id]);
    if (!current) return res.status(404).json({ error: 'No such transaction.' });

    const row = await one(
      `UPDATE transactions
          SET date = $3, amount = $4, category = $5, fund = $6, party = $7, description = $8, method = $9
        WHERE organization_id = $1 AND id = $2
        RETURNING *`,
      [
        req.orgId, req.params.id,
        b.date || current.date,
        b.amount === undefined ? current.amount : amountOf(b.amount),
        b.category === undefined ? current.category : String(b.category),
        b.fund === undefined ? current.fund : b.fund,
        b.party === undefined ? current.party : String(b.party),
        b.description === undefined ? current.description : String(b.description),
        b.method || current.method
      ]
    );
    res.json({ tx: shape.txShape(row) });
  } catch (err) {
    next(err);
  }
});

router.delete('/transactions/:id', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await one(
      'DELETE FROM transactions WHERE organization_id = $1 AND id = $2 RETURNING id, source',
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such transaction.' });
    await audit(req.orgId, req.user.id, 'transaction.deleted', 'transaction', row.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Codes every transaction still awaiting a category. Keyword rules run first;
// anything they cannot place goes to Claude, when a key is configured.
router.post('/transactions/categorize', requireOrg('accountant'), async (req, res, next) => {
  try {
    const pending = await many(
      "SELECT * FROM transactions WHERE organization_id = $1 AND category = '' ORDER BY date DESC",
      [req.orgId]
    );
    const allowed = {
      income: await allowedCategories(req.orgId, 'income'),
      expense: await allowedCategories(req.orgId, 'expense')
    };

    const updated = [];
    for (const t of pending) {
      const haystack = (t.party || '') + ' ' + (t.description || '');
      let category = byKeyword(haystack, allowed[t.type]);
      if (!category && anthropic.configured()) {
        try {
          category = await anthropic.suggestCategory({
            type: t.type,
            party: t.party,
            description: t.description,
            amount: t.amount,
            allowed: allowed[t.type]
          });
        } catch (err) {
          // A model outage must not fail the whole run — the keyword result
          // for other rows still stands and these stay uncoded.
          console.error('category suggestion failed: ' + err.message);
        }
      }
      if (!category) continue;
      const row = await one(
        'UPDATE transactions SET category = $3 WHERE organization_id = $1 AND id = $2 RETURNING *',
        [req.orgId, t.id, category]
      );
      updated.push(shape.txShape(row));
    }

    if (updated.length) {
      await audit(req.orgId, req.user.id, 'transaction.categorised', 'transaction', null, { count: updated.length });
    }
    res.json({ updated, count: updated.length });
  } catch (err) {
    next(err);
  }
});

// ---------------- invoices, pledges and bills ----------------

async function nextNumber(client, orgId, table, prefix, base) {
  const { rows } = await client.query(
    `SELECT number FROM ${table} WHERE organization_id = $1 AND number LIKE $2`,
    [orgId, prefix + '%']
  );
  const highest = rows.reduce((max, r) => {
    const n = parseInt(String(r.number).slice(prefix.length), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, base - 1);
  return prefix + (highest + 1);
}

function documentRoutes({ path, table, contactTable, contactColumn, nameColumn, paymentTable, prefix, base, label }) {
  router.post('/' + path, requireOrg('accountant'), async (req, res, next) => {
    try {
      const b = req.body || {};
      const total = amountOf(b.total);
      if (!total) return res.status(400).json({ error: 'Enter an amount.' });
      const partyName = String(b.party || '').trim();
      if (!partyName) return res.status(400).json({ error: 'Choose who this is for.' });

      const result = await transaction(async (client) => {
        // A name that already exists reuses that contact instead of creating
        // a second record with the same name.
        let contact = (await client.query(
          `SELECT * FROM ${contactTable} WHERE organization_id = $1 AND lower(name) = lower($2)`,
          [req.orgId, partyName]
        )).rows[0];

        let createdContact = null;
        if (!contact && b.createContact) {
          contact = (await client.query(
            `INSERT INTO ${contactTable} (organization_id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.orgId, partyName, String(b.email || '').trim() || null, String(b.phone || '').trim() || null]
          )).rows[0];
          createdContact = shape.contactShape(contact);
        }

        // Church books issue pledges rather than invoices, under their own series.
        const series = table === 'invoices' && req.bookType === 'church'
          ? { prefix: 'PLG-', base: 301 }
          : { prefix, base };
        const number = b.number || (await nextNumber(client, req.orgId, table, series.prefix, series.base));
        const doc = (await client.query(
          `INSERT INTO ${table}
             (organization_id, number, ${contactColumn}, ${nameColumn}, issue_date, due_date, total, fund, notes, base_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, number, ${contactColumn} AS party_id, ${nameColumn} AS party_name,
                     issue_date, due_date, total, base_status, 0 AS paid`,
          [
            req.orgId, number, contact ? contact.id : null, partyName,
            b.issue || today(), b.due || today(), total,
            b.fund || null, b.notes || null,
            b.base === 'draft' ? 'draft' : 'sent'
          ]
        )).rows[0];

        return { doc: shape.docShape(doc), contact: createdContact };
      });

      await audit(req.orgId, req.user.id, label + '.created', label, result.doc.id, { total, party: partyName });
      res.status(201).json(result);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That document number is already used.' });
      next(err);
    }
  });

  router.delete('/' + path + '/:id', requireOrg('admin'), async (req, res, next) => {
    try {
      // Payments and line items go with the document; the cash transactions
      // they posted stay, because money that moved is a fact.
      const row = await one(
        `DELETE FROM ${table} WHERE organization_id = $1 AND id = $2 RETURNING id, number`,
        [req.orgId, req.params.id]
      );
      if (!row) return res.status(404).json({ error: 'No such document.' });
      await audit(req.orgId, req.user.id, label + '.deleted', label, row.id, { number: row.number });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Recording a payment moves cash, so it writes the payment and its ledger
  // transaction in one transaction — never one without the other.
  router.post('/' + path + '/:id/payments', requireOrg('accountant'), async (req, res, next) => {
    try {
      const amount = amountOf((req.body || {}).amount);
      if (!amount) return res.status(400).json({ error: 'Enter a payment amount.' });
      const isBill = path === 'bills';

      const result = await transaction(async (client) => {
        const doc = (await client.query(
          `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [req.orgId, req.params.id]
        )).rows[0];
        if (!doc) {
          const err = new Error('No such document.');
          err.status = 404;
          throw err;
        }

        const payment = (await client.query(
          `INSERT INTO ${paymentTable} (${isBill ? 'bill_id' : 'invoice_id'}, amount, date, method)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [doc.id, amount, (req.body || {}).date || today(), (req.body || {}).method || 'Bank transfer']
        )).rows[0];

        const church = req.bookType === 'church';
        const ledger = (await client.query(
          `INSERT INTO transactions
             (organization_id, type, date, amount, category, fund, party, description, method, bank_account_id,
              source, ${isBill ? 'ref_bill_id' : 'ref_invoice_id'}, ref_payment_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [
            req.orgId,
            isBill ? 'expense' : 'income',
            payment.date, amount,
            isBill ? 'Inventory Purchases' : church ? 'Donations & Grants' : 'Product Sales',
            church ? 'General Fund' : null,
            doc[nameColumn],
            'Payment against ' + doc.number,
            payment.method,
            await banking.resolveAccount(req.orgId, (req.body || {}).bankAccountId, payment.method),
            isBill ? 'bill' : 'invoice',
            doc.id, payment.id, req.user.id
          ]
        )).rows[0];

        const paid = (await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid FROM ${paymentTable} WHERE ${isBill ? 'bill_id' : 'invoice_id'} = $1`,
          [doc.id]
        )).rows[0].paid;

        return {
          doc: shape.docShape({
            id: doc.id, number: doc.number, party_id: doc[contactColumn], party_name: doc[nameColumn],
            issue_date: doc.issue_date, due_date: doc.due_date, total: doc.total,
            base_status: doc.base_status, paid: Number(paid)
          }),
          tx: shape.txShape(ledger)
        };
      });

      await audit(req.orgId, req.user.id, label + '.payment_recorded', label, req.params.id, { amount });
      res.status(201).json(result);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  });
}

documentRoutes({
  path: 'invoices', table: 'invoices', contactTable: 'clients',
  contactColumn: 'client_id', nameColumn: 'client_name', paymentTable: 'invoice_payments',
  prefix: 'INV-', base: 1001, label: 'invoice'
});

documentRoutes({
  path: 'bills', table: 'bills', contactTable: 'vendors',
  contactColumn: 'vendor_id', nameColumn: 'vendor_name', paymentTable: 'bill_payments',
  prefix: 'BILL-', base: 2001, label: 'bill'
});

// ---------------- inventory ----------------

router.post('/inventory', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the item a name.' });

    const row = await one(
      `INSERT INTO inventory_items
         (organization_id, name, sku, supplier, cost, price, qty_purchased, qty_sold, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING *`,
      [
        req.orgId, name, String(b.sku || '') || null, String(b.supplier || '') || null,
        amountOf(b.cost), amountOf(b.price), amountOf(b.purchased), amountOf(b.reorder)
      ]
    );
    res.status(201).json({ item: shape.itemShape(row) });
  } catch (err) {
    next(err);
  }
});

// A stock move posts its own ledger entry, so cost of goods and sales stay in
// step with the quantities.
router.post('/inventory/:id/move', requireOrg('accountant'), async (req, res, next) => {
  try {
    const dir = (req.body || {}).dir === 'buy' ? 'buy' : 'sell';
    const qty = Math.max(1, Number((req.body || {}).qty) || (dir === 'buy' ? 10 : 5));

    const result = await transaction(async (client) => {
      const item = (await client.query(
        'SELECT * FROM inventory_items WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [req.orgId, req.params.id]
      )).rows[0];
      if (!item) {
        const err = new Error('No such item.');
        err.status = 404;
        throw err;
      }

      const sellable = item.qty_purchased - item.qty_sold;
      if (dir === 'sell' && qty > sellable) {
        const err = new Error('Only ' + sellable + ' units are in stock.');
        err.status = 400;
        throw err;
      }

      const updated = (await client.query(
        dir === 'buy'
          ? 'UPDATE inventory_items SET qty_purchased = qty_purchased + $3 WHERE organization_id = $1 AND id = $2 RETURNING *'
          : 'UPDATE inventory_items SET qty_sold = qty_sold + $3 WHERE organization_id = $1 AND id = $2 RETURNING *',
        [req.orgId, item.id, qty]
      )).rows[0];

      const bankAccountId = dir === 'buy'
        ? await banking.resolveAccount(req.orgId, null, 'Bank transfer')
        : null;
      const ledger = (await client.query(
        `INSERT INTO transactions
           (organization_id, type, date, amount, category, party, description, method, bank_account_id,
            source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stock', $10) RETURNING *`,
        dir === 'buy'
          ? [req.orgId, 'expense', today(), qty * item.cost, 'Inventory Purchases', item.supplier || '',
             'Received ' + qty + ' × ' + item.name, 'Bank transfer', bankAccountId, req.user.id]
          // A counter sale is cash, so it deliberately lands on no account.
          : [req.orgId, 'income', today(), qty * item.price, 'Product Sales', 'Counter sale',
             'Sold ' + qty + ' × ' + item.name, 'Cash', null, req.user.id]
      )).rows[0];

      return { item: shape.itemShape(updated), tx: shape.txShape(ledger) };
    });

    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/inventory/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await one(
      'DELETE FROM inventory_items WHERE organization_id = $1 AND id = $2 RETURNING id',
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such item.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
