// Invoice documents.
//
// Mounted inside the org-scoped router, so `requireOrg` has already decided
// that this caller belongs to these books — the same single choke point every
// other route goes through. An invoice belonging to another organisation is a
// 404 here exactly as it is everywhere else.

const express = require('express');
const { one, many } = require('../db');
const { requireOrg, audit } = require('../auth');
const money = require('../money');
const totals = require('../invoicing/totals');
const pdf = require('../invoicing/pdf');
const { THEMES, NAMES, DEFAULT } = require('../invoicing/themes');
const accounting = require('../accounting/reports');
const backfill = require('../accounting/backfill');

const router = express.Router({ mergeParams: true });

// Everything the document needs, in one place, so the PDF and any future
// preview or email render from identical figures.
async function assemble(orgId, invoiceId, bookType) {
  const invoice = await one(
    `SELECT i.*,
            COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM invoices i
      WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, invoiceId]
  );
  if (!invoice) return null;

  const [org, lines] = await Promise.all([
    one('SELECT * FROM organizations WHERE id = $1', [orgId]),
    many('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position, created_at', [invoiceId])
  ]);

  // An invoice written before line items existed has one amount and no lines.
  // Rather than printing an empty table, it becomes a single line — which is
  // what it always was.
  const computed = lines.length
    ? {
      lines: lines.map((l) => ({
        description: l.description,
        unit: l.unit,
        qty: Number(l.qty_milli),
        unitPrice: Number(l.unit_price_kobo),
        treatment: l.tax_treatment,
        taxBp: l.tax_bp,
        whtBp: l.wht_bp,
        discount: Number(l.discount_kobo),
        net: Number(l.net_kobo),
        tax: Number(l.tax_kobo),
        wht: Number(l.wht_kobo),
        total: Number(l.total_kobo)
      })),
      net: lines.reduce((a, l) => a + Number(l.net_kobo), 0),
      tax: lines.reduce((a, l) => a + Number(l.tax_kobo), 0),
      wht: lines.reduce((a, l) => a + Number(l.wht_kobo), 0),
      discount: lines.reduce((a, l) => a + Number(l.discount_kobo), 0)
    }
    : (() => {
      const net = Number(invoice.subtotal_kobo || invoice.total_kobo || 0);
      return {
        lines: [{
          description: invoice.notes || 'Services rendered',
          unit: null, qty: money.QTY, unitPrice: net,
          treatment: 'no_vat', taxBp: 0, whtBp: 0,
          discount: 0, net, tax: 0, wht: 0, total: net
        }],
        net, tax: 0, wht: 0, discount: 0
      };
    })();

  const figures = {
    lines: computed.lines,
    net: computed.net,
    tax: computed.tax,
    discount: computed.discount,
    wht: computed.wht,
    total: computed.net + computed.tax,
    payableNow: computed.net + computed.tax - computed.wht
  };

  const paidKobo = money.toKobo(invoice.paid);
  const outstanding = Number(invoice.total_kobo) - paidKobo;

  return {
    org,
    template: NAMES.includes(invoice.template) ? invoice.template : DEFAULT,
    brand: null,
    // The renderer reads lines from here, not from inside totals. Leaving it
    // out produced a document with a correct grand total above an empty
    // table, which is exactly the kind of wrong that gets emailed to a
    // customer before anybody notices.
    lines: figures.lines,
    invoice: {
      id: invoice.id,
      number: invoice.number,
      // Church books issue pledges, and a document that calls itself an
      // invoice when the business calls it a pledge is the wrong document.
      documentLabel: bookType === 'church' ? 'PLEDGE' : 'INVOICE',
      party: invoice.client_name,
      billingAddress: invoice.billing_address,
      shippingAddress: invoice.shipping_address,
      customerReference: invoice.customer_reference,
      purchaseOrder: invoice.purchase_order,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      notes: invoice.notes,
      terms: invoice.terms,
      paymentInstructions: invoice.payment_instructions,
      // Said on the face of the document rather than left to be worked out.
      watermark: invoice.voided_at ? 'VOID'
        : invoice.base_status === 'draft' ? 'DRAFT'
          : outstanding <= 0 ? 'PAID' : null
    },
    totals: figures,
    paid: paidKobo,
    outstanding
  };
}

// The document itself. Viewer may download: it is their organisation's
// invoice and they can already read every figure on it.
router.get('/invoices/:id/pdf', requireOrg(), async (req, res, next) => {
  try {
    const data = await assemble(req.orgId, req.params.id, req.bookType);
    if (!data) return res.status(404).json({ error: 'No such invoice.' });

    const buffer = await pdf.render(data);
    const safe = String(data.invoice.number || 'invoice').replace(/[^A-Za-z0-9._-]/g, '-');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    // `inline` so a click opens it in the browser's viewer, where printing is
    // one more click. ?download=1 forces the save dialog instead.
    res.setHeader(
      'Content-Disposition',
      (req.query.download ? 'attachment' : 'inline') + '; filename="' + safe + '.pdf"'
    );
    // A document that has not changed should not be re-rendered on a refresh,
    // but it must never be cached by anything in between: it is one tenant's
    // financial document.
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// What the invoice adds up to, without rendering it — for the builder's live
// preview, which must agree with the PDF because both come from here.
router.post('/invoices/preview', requireOrg('accountant'), async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organizations WHERE id = $1', [req.orgId]);
    const body = req.body || {};
    const computed = totals.compute(body.lines, {
      taxInclusive: body.taxInclusive === undefined
        ? org.prices_include_vat : Boolean(body.taxInclusive),
      // A business that is not VAT-registered must not have 7.5% quietly
      // applied because a default said so.
      taxRate: org.vat_registered ? org.vat_rate : 0,
      taxTreatment: org.vat_registered ? 'standard' : 'no_vat',
      whtRate: money.fromBasisPoints(org.default_wht_bp || 0)
    });
    res.json({ totals: computed, display: totals.presentable(computed) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- the ledger
//
// Read-only and role-gated like everything else: a viewer may read their own
// organisation's accounts, because they can already read every figure these
// are derived from.

router.get('/ledger/trial-balance', requireOrg(), async (req, res, next) => {
  try {
    res.json(await accounting.trialBalance(req.orgId, { from: req.query.from, to: req.query.to }));
  } catch (err) { next(err); }
});

router.get('/ledger/profit-and-loss', requireOrg(), async (req, res, next) => {
  try {
    res.json(await accounting.profitAndLoss(req.orgId, { from: req.query.from, to: req.query.to }));
  } catch (err) { next(err); }
});

router.get('/ledger/balance-sheet', requireOrg(), async (req, res, next) => {
  try {
    res.json(await accounting.balanceSheet(req.orgId, { asOf: req.query.asOf }));
  } catch (err) { next(err); }
});

router.get('/ledger/receivables', requireOrg(), async (req, res, next) => {
  try {
    res.json(await accounting.receivablesAgeing(req.orgId, { asOf: req.query.asOf }));
  } catch (err) { next(err); }
});

router.get('/ledger/accounts/:accountId', requireOrg(), async (req, res, next) => {
  try {
    res.json({
      entries: await accounting.ledgerFor(req.orgId, req.params.accountId, {
        from: req.query.from, to: req.query.to, limit: req.query.limit
      })
    });
  } catch (err) { next(err); }
});

// Whether the ledger has caught up with the books, and the one number that
// says whether any of the above can be trusted.
router.get('/ledger/health', requireOrg(), async (req, res, next) => {
  try {
    const [coverage, tb] = await Promise.all([
      accounting.coverage(req.orgId),
      accounting.trialBalance(req.orgId)
    ]);
    res.json({
      coverage,
      balanced: tb.balanced,
      difference: tb.difference,
      note: !tb.balanced
        ? 'The ledger does not balance. Nothing derived from it should be relied on until this is looked at.'
        : coverage.complete
          ? 'Every invoice and cash entry is posted.'
          : coverage.unpostedTransactions + coverage.unpostedInvoices +
            ' documents are still being posted. The ledger catches up in the background.'
    });
  } catch (err) { next(err); }
});

// Post whatever is outstanding for this organisation now, rather than waiting
// for the background pass. Admin only: it writes to the ledger.
router.post('/ledger/post-pending', requireOrg('admin'), async (req, res, next) => {
  try {
    const result = await backfill.run({ organizationId: req.orgId });
    await audit(req.orgId, req.user.id, 'ledger.backfilled', 'organization', req.orgId, result);
    res.json(result);
  } catch (err) { next(err); }
});

// The designs on offer, for the settings screen.
router.get('/invoice-templates', requireOrg(), (req, res) => {
  res.json({
    templates: NAMES.map((name) => ({
      name, label: THEMES[name].label, accent: THEMES[name].accent
    })),
    default: DEFAULT
  });
});

module.exports = { router, assemble };
