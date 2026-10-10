const express = require('express');
const { one, many, query } = require('../db');
const { requireOrg, audit } = require('../auth');

// The company's own accounts, and the branding that goes on its reports.
//
// Two rules hold this together. A bank account's balance is its opening
// balance plus everything recorded against it — never a stored figure that
// drifts. And organizations.opening_cash stays equal to the sum of those
// opening balances, so the dashboard, the cash series and the reports carry
// on reading one number without knowing it is now made of several.

const router = express.Router({ mergeParams: true });

const MAX_LOGO_BYTES = 400 * 1024;

// Methods that move money through a bank. Cash does not, which is why a cash
// sale must not land on a bank balance.
const BANK_METHODS = ['Bank transfer', 'Card', 'Cheque', 'POS', 'Transfer'];

function bad(res, message) {
  return res.status(400).json({ error: message });
}

function money(value, fallback) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

// Called after every change to an account. One statement, so the two numbers
// cannot disagree even if two people are editing at once.
async function syncOpeningCash(organizationId) {
  await query(
    `UPDATE organizations o
        SET opening_cash = COALESCE(
              (SELECT SUM(b.opening_balance) FROM bank_accounts b
                WHERE b.organization_id = o.id AND b.archived_at IS NULL), 0)
      WHERE o.id = $1`,
    [organizationId]
  );
}

// Opening balance plus the net of everything recorded against the account.
// Derived at read time, like every other balance in this product.
function accountsWithBalances(organizationId) {
  return many(
    `SELECT b.id, b.name, b.bank_name AS "bankName", b.account_number AS "accountNumber",
            b.opening_balance AS "openingBalance", b.opening_date AS "openingDate",
            b.is_primary AS "isPrimary", b.sort_order AS "sortOrder",
            COALESCE(t.received, 0) AS received,
            COALESCE(t.paid, 0)     AS paid,
            b.opening_balance + COALESCE(t.received, 0) - COALESCE(t.paid, 0) AS balance,
            COALESCE(t.entries, 0)  AS entries
       FROM bank_accounts b
       LEFT JOIN LATERAL (
         SELECT SUM(amount) FILTER (WHERE type = 'income')  AS received,
                SUM(amount) FILTER (WHERE type = 'expense') AS paid,
                COUNT(*)::int                               AS entries
           FROM transactions WHERE bank_account_id = b.id
       ) t ON true
      WHERE b.organization_id = $1 AND b.archived_at IS NULL
      ORDER BY b.is_primary DESC, b.sort_order, b.created_at`,
    [organizationId]
  );
}

// Where a bank payment goes when the entry does not say. Exported so the
// ledger can use exactly the same rule.
async function resolveAccount(organizationId, requestedId, method) {
  if (requestedId) {
    const chosen = await one(
      'SELECT id FROM bank_accounts WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
      [requestedId, organizationId]
    );
    if (chosen) return chosen.id;
  }
  if (!BANK_METHODS.includes(String(method || ''))) return null;
  const primary = await one(
    `SELECT id FROM bank_accounts
      WHERE organization_id = $1 AND archived_at IS NULL
      ORDER BY is_primary DESC, sort_order, created_at LIMIT 1`,
    [organizationId]
  );
  return primary ? primary.id : null;
}

// -------------------------------------------------------------------------
// Accounts
// -------------------------------------------------------------------------

router.get('/bank-accounts', requireOrg(), async (req, res, next) => {
  try {
    const accounts = await accountsWithBalances(req.orgId);
    res.json({
      accounts,
      total: accounts.reduce((sum, a) => sum + Number(a.balance), 0),
      openingTotal: accounts.reduce((sum, a) => sum + Number(a.openingBalance), 0)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bank-accounts', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'Give the account a name — the bank and the last digits, say.');

    const opening = money(b.openingBalance, null);
    if (opening === null) return bad(res, 'Enter the opening balance as a number.');
    if (b.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.openingDate))) {
      return bad(res, 'Give the opening date as YYYY-MM-DD.');
    }

    const existing = await one(
      'SELECT COUNT(*)::int AS n FROM bank_accounts WHERE organization_id = $1 AND archived_at IS NULL',
      [req.orgId]
    );
    // The first account an organisation has is its primary one; after that it
    // is only primary if asked for.
    const primary = existing.n === 0 ? true : Boolean(b.isPrimary);
    if (primary && existing.n > 0) {
      await query('UPDATE bank_accounts SET is_primary = false WHERE organization_id = $1', [req.orgId]);
    }

    const row = await one(
      `INSERT INTO bank_accounts
         (organization_id, name, bank_name, account_number, opening_balance, opening_date, is_primary, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8)
       RETURNING id`,
      [
        req.orgId, name.slice(0, 120),
        String(b.bankName || '').trim().slice(0, 120) || null,
        String(b.accountNumber || '').replace(/[^0-9]/g, '').slice(0, 20) || null,
        opening, b.openingDate || null, primary, existing.n
      ]
    );

    await syncOpeningCash(req.orgId);
    await audit(req.orgId, req.user.id, 'bank_account.added', 'bank_account', row.id, { name, opening });
    res.status(201).json({ accounts: await accountsWithBalances(req.orgId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/bank-accounts/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const current = await one(
      'SELECT * FROM bank_accounts WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
      [req.params.id, req.orgId]
    );
    if (!current) return res.status(404).json({ error: 'No such account.' });

    const name = b.name === undefined ? current.name : String(b.name).trim();
    if (!name) return bad(res, 'An account needs a name.');
    const opening = b.openingBalance === undefined ? Number(current.opening_balance) : money(b.openingBalance, null);
    if (opening === null) return bad(res, 'Enter the opening balance as a number.');
    if (b.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.openingDate))) {
      return bad(res, 'Give the opening date as YYYY-MM-DD.');
    }

    if (b.isPrimary === true && !current.is_primary) {
      await query('UPDATE bank_accounts SET is_primary = false WHERE organization_id = $1', [req.orgId]);
    }

    await query(
      `UPDATE bank_accounts
          SET name = $3, bank_name = $4, account_number = $5,
              opening_balance = $6, opening_date = COALESCE($7::date, opening_date),
              is_primary = $8
        WHERE id = $1 AND organization_id = $2`,
      [
        current.id, req.orgId, name.slice(0, 120),
        b.bankName === undefined ? current.bank_name : (String(b.bankName).trim().slice(0, 120) || null),
        b.accountNumber === undefined
          ? current.account_number
          : (String(b.accountNumber).replace(/[^0-9]/g, '').slice(0, 20) || null),
        opening,
        b.openingDate || null,
        b.isPrimary === undefined ? current.is_primary : Boolean(b.isPrimary)
      ]
    );

    await syncOpeningCash(req.orgId);
    await audit(req.orgId, req.user.id, 'bank_account.updated', 'bank_account', current.id, {
      name,
      openingFrom: Number(current.opening_balance),
      openingTo: opening
    });
    res.json({ accounts: await accountsWithBalances(req.orgId) });
  } catch (err) {
    next(err);
  }
});

// Archived rather than deleted: entries already recorded against it keep
// pointing somewhere real, so nothing in the history changes shape.
router.delete('/bank-accounts/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const current = await one(
      'SELECT * FROM bank_accounts WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
      [req.params.id, req.orgId]
    );
    if (!current) return res.status(404).json({ error: 'No such account.' });

    const left = await one(
      'SELECT COUNT(*)::int AS n FROM bank_accounts WHERE organization_id = $1 AND archived_at IS NULL AND id <> $2',
      [req.orgId, current.id]
    );
    if (left.n === 0) {
      return bad(res, 'These books need at least one account. Add another before removing this one.');
    }

    await query('UPDATE bank_accounts SET archived_at = now(), is_primary = false WHERE id = $1', [current.id]);
    if (current.is_primary) {
      // Something has to be primary, or the next bank payment has nowhere to go.
      await query(
        `UPDATE bank_accounts SET is_primary = true
          WHERE id = (SELECT id FROM bank_accounts
                       WHERE organization_id = $1 AND archived_at IS NULL
                       ORDER BY sort_order, created_at LIMIT 1)`,
        [req.orgId]
      );
    }

    await syncOpeningCash(req.orgId);
    await audit(req.orgId, req.user.id, 'bank_account.removed', 'bank_account', current.id, { name: current.name });
    res.json({ accounts: await accountsWithBalances(req.orgId) });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Logo
// -------------------------------------------------------------------------

// Checked by what the bytes actually are, not by what the upload claims. A
// file that says it is a PNG and is not has no business being served back to
// somebody's browser.
function sniff(buffer) {
  if (buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // SVG is deliberately not accepted: it is a document that can carry script,
  // and this is served back to browsers.
  return null;
}

router.post('/logo', requireOrg('admin'), async (req, res, next) => {
  try {
    const raw = String((req.body || {}).data || '');
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    if (!base64) return bad(res, 'Choose an image file.');

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return bad(res, 'That file could not be read.');
    if (buffer.length > MAX_LOGO_BYTES) {
      return bad(res, 'That image is ' + Math.round(buffer.length / 1024) + 'KB. Use one under 400KB.');
    }

    const mime = sniff(buffer);
    if (!mime) return bad(res, 'Use a PNG, JPEG or WebP image.');

    await query(
      'UPDATE organizations SET logo = $2, logo_mime = $3, logo_updated_at = now() WHERE id = $1',
      [req.orgId, buffer, mime]
    );
    await audit(req.orgId, req.user.id, 'organization.logo_set', 'organization', req.orgId, {
      bytes: buffer.length,
      mime
    });

    const row = await one('SELECT logo_updated_at FROM organizations WHERE id = $1', [req.orgId]);
    res.status(201).json({ logo: { mime, bytes: buffer.length, updatedAt: row.logo_updated_at } });
  } catch (err) {
    next(err);
  }
});

router.delete('/logo', requireOrg('admin'), async (req, res, next) => {
  try {
    await query(
      'UPDATE organizations SET logo = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = $1',
      [req.orgId]
    );
    await audit(req.orgId, req.user.id, 'organization.logo_cleared', 'organization', req.orgId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/logo', requireOrg(), async (req, res, next) => {
  try {
    const row = await one('SELECT logo, logo_mime, logo_updated_at FROM organizations WHERE id = $1', [req.orgId]);
    if (!row || !row.logo) return res.status(404).json({ error: 'No logo on this organisation.' });

    // Locked down on the way out: whatever the bytes are, the browser renders
    // them as an image and nothing else.
    res.set('Content-Type', row.logo_mime);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=300');
    res.set('ETag', '"' + new Date(row.logo_updated_at).getTime() + '"');
    res.send(row.logo);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, resolveAccount, syncOpeningCash, accountsWithBalances, BANK_METHODS, MAX_LOGO_BYTES };
