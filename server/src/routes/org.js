const express = require('express');
const { many, one, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const shape = require('../shape');

const router = express.Router({ mergeParams: true });

const INVOICE_SELECT = `
  SELECT i.id, i.number, i.client_id AS party_id, i.client_name AS party_name,
         i.issue_date, i.due_date, i.total, i.base_status,
         COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid
    FROM invoices i
   WHERE i.organization_id = $1
   ORDER BY i.issue_date DESC, i.created_at DESC`;

const BILL_SELECT = `
  SELECT b.id, b.number, b.vendor_id AS party_id, b.vendor_name AS party_name,
         b.issue_date, b.due_date, b.total, b.base_status,
         COALESCE((SELECT SUM(p.amount) FROM bill_payments p WHERE p.bill_id = b.id), 0) AS paid
    FROM bills b
   WHERE b.organization_id = $1
   ORDER BY b.issue_date DESC, b.created_at DESC`;

// One call returns the whole book. The UI holds it in the same state shape the
// prototype seeded locally, so every screen and calculation works unchanged.
router.get('/data', requireOrg(), async (req, res, next) => {
  try {
    const id = req.orgId;
    const [org, clients, vendors, tx, inv, bills, inventory, bank, expenseCats, incomeCats, funds] =
      await Promise.all([
        one('SELECT * FROM organizations WHERE id = $1', [id]),
        many('SELECT * FROM clients WHERE organization_id = $1 ORDER BY name', [id]),
        many('SELECT * FROM vendors WHERE organization_id = $1 ORDER BY name', [id]),
        many('SELECT * FROM transactions WHERE organization_id = $1 ORDER BY date DESC, created_at DESC', [id]),
        many(INVOICE_SELECT, [id]),
        many(BILL_SELECT, [id]),
        many('SELECT * FROM inventory_items WHERE organization_id = $1 ORDER BY name', [id]),
        many('SELECT * FROM bank_statement_lines WHERE organization_id = $1 ORDER BY date DESC', [id]),
        many('SELECT name, deductible_pct FROM expense_categories WHERE organization_id = $1 ORDER BY sort_order, name', [id]),
        many('SELECT name FROM income_categories WHERE organization_id = $1 ORDER BY sort_order, name', [id]),
        many('SELECT name FROM funds WHERE organization_id = $1 ORDER BY sort_order, name', [id])
      ]);

    res.json({
      org: shape.orgShape(org),
      role: req.role,
      book: {
        clients: clients.map(shape.contactShape),
        vendors: vendors.map(shape.contactShape),
        tx: tx.map(shape.txShape),
        inv: inv.map(shape.docShape),
        bills: bills.map(shape.docShape),
        inventory: inventory.map(shape.itemShape),
        bank: bank.map(shape.bankShape),
        cats: expenseCats.map((c) => ({ name: c.name, pct: Number(c.deductible_pct) })),
        income: incomeCats.map((c) => c.name),
        funds: funds.map((f) => f.name)
      }
    });
  } catch (err) {
    next(err);
  }
});

// ---------------- organisation settings ----------------

router.patch('/', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const num = (v, fallback) => {
      const n = Number(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : fallback;
    };
    const current = await one('SELECT * FROM organizations WHERE id = $1', [req.orgId]);

    const updated = await one(
      `UPDATE organizations
          SET name = $2, business_type = $3, state = $4, vat_rate = $5,
              opening_cash = $6, owner_contributions = $7, fixed_assets = $8
        WHERE id = $1
        RETURNING *`,
      [
        req.orgId,
        String(b.name || current.name).trim() || current.name,
        String(b.type || current.business_type),
        b.state === undefined ? current.state : String(b.state),
        num(b.vatRate, current.vat_rate),
        num(b.openingCash, current.opening_cash),
        num(b.contributions, current.owner_contributions),
        num(b.fixedAssets, current.fixed_assets)
      ]
    );
    await audit(req.orgId, req.user.id, 'organization.updated', 'organization', req.orgId);
    res.json({ org: shape.orgShape(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------- chart of accounts ----------------

router.post('/income-categories', requireOrg('accountant'), async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the account a name.' });

    const existing = await one(
      'SELECT name FROM income_categories WHERE organization_id = $1 AND lower(name) = lower($2)',
      [req.orgId, name]
    );
    if (existing) return res.json({ name: existing.name, created: false });

    await query('INSERT INTO income_categories (organization_id, name, sort_order) VALUES ($1, $2, 999)', [req.orgId, name]);
    await audit(req.orgId, req.user.id, 'category.created', 'income_category', null, { name });
    res.status(201).json({ name, created: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/income-categories/:name', requireOrg('accountant'), async (req, res, next) => {
  try {
    const name = req.params.name;
    const used = await one(
      "SELECT 1 FROM transactions WHERE organization_id = $1 AND category = $2 LIMIT 1",
      [req.orgId, name]
    );
    if (used) return res.status(409).json({ error: 'Transactions are posted to that account, so it cannot be removed.' });

    await query('DELETE FROM income_categories WHERE organization_id = $1 AND name = $2', [req.orgId, name]);
    await audit(req.orgId, req.user.id, 'category.deleted', 'income_category', null, { name });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/expense-categories', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the account a name.' });
    const pct = Math.max(0, Math.min(100, Number(b.pct) || 0));

    const existing = await one(
      'SELECT name, deductible_pct FROM expense_categories WHERE organization_id = $1 AND lower(name) = lower($2)',
      [req.orgId, name]
    );
    if (existing) return res.json({ name: existing.name, pct: Number(existing.deductible_pct), created: false });

    await query(
      'INSERT INTO expense_categories (organization_id, name, deductible_pct, sort_order) VALUES ($1, $2, $3, 999)',
      [req.orgId, name, pct]
    );
    await audit(req.orgId, req.user.id, 'category.created', 'expense_category', null, { name, pct });
    res.status(201).json({ name, pct, created: true });
  } catch (err) {
    next(err);
  }
});

// Editing the allowable percentage is what recalculates the tax summary.
router.patch('/expense-categories/:name', requireOrg('accountant'), async (req, res, next) => {
  try {
    const pct = Math.max(0, Math.min(100, Number((req.body || {}).pct) || 0));
    const updated = await one(
      'UPDATE expense_categories SET deductible_pct = $3 WHERE organization_id = $1 AND name = $2 RETURNING name, deductible_pct',
      [req.orgId, req.params.name, pct]
    );
    if (!updated) return res.status(404).json({ error: 'No such account.' });
    res.json({ name: updated.name, pct: Number(updated.deductible_pct) });
  } catch (err) {
    next(err);
  }
});

// ---------------- contacts ----------------

for (const [path, table, label] of [['clients', 'clients', 'client'], ['vendors', 'vendors', 'vendor']]) {
  router.post('/' + path, requireOrg('accountant'), async (req, res, next) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Enter a name.' });

      // Duplicate names reuse the existing record rather than creating a second.
      const existing = await one(
        'SELECT * FROM ' + table + ' WHERE organization_id = $1 AND lower(name) = lower($2)',
        [req.orgId, name]
      );
      if (existing) return res.json({ contact: shape.contactShape(existing), created: false });

      const row = await one(
        'INSERT INTO ' + table + ' (organization_id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.orgId, name, String(b.email || '').trim() || null, String(b.phone || '').trim() || null]
      );
      await audit(req.orgId, req.user.id, label + '.created', label, row.id, { name });
      res.status(201).json({ contact: shape.contactShape(row), created: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/' + path + '/:id', requireOrg('accountant'), async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = await one(
        'UPDATE ' + table + ' SET name = COALESCE($3, name), email = $4, phone = $5' +
          ' WHERE organization_id = $1 AND id = $2 RETURNING *',
        [
          req.orgId, req.params.id,
          b.name ? String(b.name).trim() : null,
          b.email === undefined ? null : String(b.email).trim() || null,
          b.phone === undefined ? null : String(b.phone).trim() || null
        ]
      );
      if (!row) return res.status(404).json({ error: 'No such contact.' });
      res.json({ contact: shape.contactShape(row) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/' + path + '/:id', requireOrg('admin'), async (req, res, next) => {
    try {
      // Documents keep the name they were issued with — the FK goes null and
      // the snapshot on the invoice or bill stands.
      const row = await one(
        'DELETE FROM ' + table + ' WHERE organization_id = $1 AND id = $2 RETURNING id, name',
        [req.orgId, req.params.id]
      );
      if (!row) return res.status(404).json({ error: 'No such contact.' });
      await audit(req.orgId, req.user.id, label + '.deleted', label, row.id, { name: row.name });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { router, INVOICE_SELECT, BILL_SELECT };
