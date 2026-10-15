// Invoice documents.
//
// Mounted inside the org-scoped router, so `requireOrg` has already decided
// that this caller belongs to these books — the same single choke point every
// other route goes through. An invoice belonging to another organisation is a
// 404 here exactly as it is everywhere else.

const express = require('express');
const { one, many, tx, tx: transaction } = require('../db');
const { requireOrg, audit } = require('../auth');
const shape = require('../shape');
const numbering = require('../invoicing/numbering');
const gl = require('../accounting/post');
const money = require('../money');
const totals = require('../invoicing/totals');
const pdf = require('../invoicing/pdf');
const { THEMES, NAMES, DEFAULT } = require('../invoicing/themes');
const accounting = require('../accounting/reports');
const backfill = require('../accounting/backfill');
const issue = require('../invoicing/issue');
const owed = require('../invoicing/outstanding');

const router = express.Router({ mergeParams: true });

// Everything the document needs, in one place, so the PDF and any future
// preview or email render from identical figures.
async function assemble(orgId, invoiceId, bookType) {
  const invoice = await one(
    `SELECT i.*, ${owed.paid('i')} AS paid_kobo, ${owed.credited('i')} AS credited_kobo
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

  const paidKobo = Number(invoice.paid_kobo);
  // A credit note reduces what is owed without any money moving, so it is
  // its own figure rather than folded into "paid" — a document telling a
  // customer they paid ₦50,000 they never paid is a document that will be
  // disputed.
  const creditedKobo = Number(invoice.credited_kobo);
  const outstanding = Number(invoice.total_kobo) - paidKobo - creditedKobo;

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
    credited: creditedKobo,
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

// ------------------------------------------------------------- the builder
//
// One route creates and updates an invoice with its lines. The figures sent
// up are ignored: totals are recomputed here from the lines, because the
// browser's arithmetic is for showing numbers as somebody types and this is
// the copy that is charged, posted and printed.

const DRAFT = 'draft';

router.post('/invoices/build', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // The write itself lives in invoicing/issue.js, because a recurring
    // schedule raises invoices too and the two must produce an identical row.
    // This route is what is left when that is taken out: a permission check,
    // a transaction, an audit line and a response shape.
    const result = await transaction((client) => issue.write(client, {
      orgId: req.orgId, userId: req.user.id, body: b, existingId: b.id || null
    }));

    await audit(req.orgId, req.user.id,
      b.status === DRAFT ? 'invoice.drafted' : 'invoice.issued', 'invoice', result.invoice.id,
      { number: result.invoice.number, total: result.computed.total });

    res.status(b.id ? 200 : 201).json({
      invoice: shape.docShape(Object.assign({}, result.invoice, {
        party_id: result.invoice.client_id, party_name: result.invoice.client_name, paid: 0
      })),
      totals: result.computed,
      display: totals.presentable(result.computed)
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That invoice number is already used.' });
    next(err);
  }
});

// Everything the builder needs to open: who the business is, its customers,
// its products, its categories and how its numbers are formed. One call, so
// the form is never half-populated while a second request is in flight.
router.get('/invoices/new', requireOrg('accountant'), async (req, res, next) => {
  try {
    const [org, clients, items, sequence] = await Promise.all([
      one('SELECT * FROM organizations WHERE id = $1', [req.orgId]),
      many('SELECT id, name, email, phone, address FROM clients WHERE organization_id = $1 ORDER BY name', [req.orgId]),
      many(`SELECT id, name, sku, price, kind FROM inventory_items
             WHERE organization_id = $1 ORDER BY name LIMIT 500`, [req.orgId]),
      tx((c) => numbering.describe(c, req.orgId, 'invoice'))
    ]);

    res.json({
      business: {
        name: org.name, address: org.address, phone: org.phone, email: org.email,
        website: org.website, tin: org.tin, rcNumber: org.rc_number,
        hasLogo: Boolean(org.logo_mime),
        vatRegistered: org.vat_registered,
        vatRate: Number(org.vat_rate),
        pricesIncludeVat: org.prices_include_vat,
        whtRate: money.fromBasisPoints(org.default_wht_bp || 0),
        terms: org.invoice_terms,
        paymentInstructions: org.payment_instructions,
        // Said plainly so the builder can prompt rather than print a blank.
        missing: ['address', 'phone', 'email', 'tin']
          .filter((f) => !org[f === 'rcNumber' ? 'rc_number' : f])
      },
      customers: clients,
      items: items.map((i) => ({
        id: i.id, name: i.name, sku: i.sku, kind: i.kind, price: money.toKobo(i.price)
      })),
      nextNumber: sequence.example,
      templates: NAMES.map((n) => ({ name: n, label: THEMES[n].label, accent: THEMES[n].accent })),
      defaultTemplate: DEFAULT
    });
  } catch (err) {
    next(err);
  }
});

// An invoice, with its lines and its timeline, for reopening a draft.
router.get('/invoices/:id/full', requireOrg(), async (req, res, next) => {
  try {
    const data = await assemble(req.orgId, req.params.id, req.bookType);
    if (!data) return res.status(404).json({ error: 'No such invoice.' });
    const events = await many(
      `SELECT event, occurred_at, detail FROM invoice_events
        WHERE invoice_id = $1 AND organization_id = $2 ORDER BY occurred_at`,
      [req.params.id, req.orgId]
    );
    res.json({ invoice: data.invoice, org: data.org, lines: data.lines, totals: data.totals,
      paid: data.paid, outstanding: data.outstanding, template: data.template, events });
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

// ---------------------------------------------------------- the dashboard
//
// One call for the whole screen. Every figure is computed from this
// organisation's own rows, with the window stated, so nothing on the page is
// a number whose meaning has to be guessed.

router.get('/invoicing/dashboard', requireOrg(), async (req, res, next) => {
  try {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to
      : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from
      : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

    const [period, counts, monthly, topCustomers, owing, recent, upcoming, ageing, repeating] = await Promise.all([
      // Invoiced and collected inside the window. Collected is read from
      // payments by payment date, not from invoice date, because a January
      // invoice paid in March was collected in March.
      one(
        `SELECT COALESCE(SUM(i.total_kobo) FILTER (WHERE i.issue_date BETWEEN $2 AND $3 AND i.base_status <> 'draft' AND i.voided_at IS NULL), 0) AS invoiced,
                COALESCE((SELECT SUM(p.amount_kobo) FROM invoice_payments p
                          WHERE p.organization_id = $1 AND p.date BETWEEN $2 AND $3), 0) AS collected
           FROM invoices i WHERE i.organization_id = $1`,
        [req.orgId, from, to]
      ),
      one(
        `WITH open AS (
           SELECT i.id, i.total_kobo AS total, i.due_date, i.base_status, i.voided_at,
                  ${owed.settled('i')} AS paid
             FROM invoices i WHERE i.organization_id = $1 AND i.voided_at IS NULL
         )
         SELECT COUNT(*) FILTER (WHERE base_status <> 'draft' AND total - paid <= 0)::int        AS paid_count,
                COUNT(*) FILTER (WHERE base_status <> 'draft' AND paid = 0 AND total > 0)::int   AS unpaid_count,
                COUNT(*) FILTER (WHERE base_status <> 'draft' AND paid > 0 AND total - paid > 0)::int AS part_count,
                COUNT(*) FILTER (WHERE base_status = 'draft')::int                               AS draft_count,
                COALESCE(SUM(total - paid) FILTER (WHERE base_status <> 'draft' AND total - paid > 0), 0) AS outstanding,
                COALESCE(SUM(total - paid) FILTER (WHERE base_status <> 'draft' AND total - paid > 0 AND due_date < CURRENT_DATE), 0) AS overdue
           FROM open`,
        [req.orgId]
      ),
      // Twelve months, quiet ones included: a gap reads as "not loaded"
      // rather than "nothing happened".
      many(
        `WITH months AS (
           SELECT generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), INTERVAL '1 month') AS m
         )
         SELECT to_char(months.m, 'YYYY-MM') AS month,
                COALESCE(SUM(i.total_kobo) FILTER (WHERE i.base_status <> 'draft' AND i.voided_at IS NULL), 0) AS invoiced,
                COALESCE((SELECT SUM(p.amount_kobo) FROM invoice_payments p
                          WHERE p.organization_id = $1 AND date_trunc('month', p.date) = months.m), 0) AS collected
           FROM months
           LEFT JOIN invoices i ON i.organization_id = $1 AND date_trunc('month', i.issue_date) = months.m
          GROUP BY months.m ORDER BY months.m`,
        [req.orgId, from, to]
      ),
      many(
        `SELECT i.client_name AS party, SUM(i.total_kobo) AS total, COUNT(*)::int AS invoices
           FROM invoices i
          WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL
            AND i.issue_date BETWEEN $2 AND $3
          GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
        [req.orgId, from, to]
      ),
      many(
        `SELECT i.client_name AS party,
                SUM(${owed.outstanding('i')}) AS owed,
                COUNT(*)::int AS invoices
           FROM invoices i
          WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL
          GROUP BY 1 HAVING SUM(${owed.outstanding('i')}) > 0
          ORDER BY 2 DESC LIMIT 6`,
        [req.orgId]
      ),
      many(
        `SELECT i.number, i.client_name AS party, p.amount_kobo, p.date, p.method
           FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE p.organization_id = $1 ORDER BY p.date DESC, p.id DESC LIMIT 6`,
        [req.orgId]
      ),
      many(
        `SELECT i.id, i.number, i.client_name AS party, i.due_date,
                ${owed.outstanding('i')} AS outstanding
           FROM invoices i
          WHERE i.organization_id = $1 AND i.base_status <> 'draft' AND i.voided_at IS NULL
            AND i.due_date >= CURRENT_DATE
          ORDER BY i.due_date LIMIT 6`,
        [req.orgId]
      ),
      accounting.receivablesAgeing(req.orgId, { asOf: to }),
      // Recurring is real now. Counted rather than reported as null, and
      // split so the card can say "4 running, 1 due" instead of a number
      // whose meaning has to be guessed.
      one(
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'active' AND next_due <= CURRENT_DATE)::int AS due,
                COUNT(*) FILTER (WHERE status = 'paused')::int AS paused
           FROM recurring_invoices WHERE organization_id = $1`,
        [req.orgId]
      )
    ]);

    const invoiced = Number(period.invoiced);
    const collected = Number(period.collected);

    // How long money actually takes to arrive: the mean gap between an
    // invoice's date and the dates its payments landed, weighted by amount.
    const collection = await one(
      // date minus date is already a count of days in Postgres, not an
      // interval — EXTRACT on it fails rather than returning the wrong
      // number, which is the better of the two ways to be wrong.
      `SELECT COALESCE(AVG(p.date - i.issue_date), 0)::numeric AS days,
              COUNT(*)::int AS payments
         FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.organization_id = $1 AND p.date BETWEEN $2 AND $3`,
      [req.orgId, from, to]
    );

    res.json({
      window: { from, to },
      metrics: {
        invoiced,
        collected,
        outstanding: Number(counts.outstanding),
        overdue: Number(counts.overdue),
        paidCount: counts.paid_count,
        unpaidCount: counts.unpaid_count,
        partCount: counts.part_count,
        draftCount: counts.draft_count,
        recurringActive: repeating.active,
        recurringDue: repeating.due,
        recurringPaused: repeating.paused,
        averageCollectionDays: Math.round(Number(collection.days)),
        collectionRate: invoiced > 0 ? Math.round((collected / invoiced) * 1000) / 10 : null
      },
      monthly: monthly.map((m) => ({
        month: m.month, invoiced: Number(m.invoiced), collected: Number(m.collected)
      })),
      topCustomers: topCustomers.map((c) => ({ party: c.party, total: Number(c.total), invoices: c.invoices })),
      owing: owing.map((c) => ({ party: c.party, owed: Number(c.owed), invoices: c.invoices })),
      recentPayments: recent.map((p) => ({
        number: p.number, party: p.party, amount: Number(p.amount_kobo), date: p.date, method: p.method
      })),
      upcoming: upcoming.map((u) => ({
        id: u.id, number: u.number, party: u.party, due: u.due_date, outstanding: Number(u.outstanding)
      })),
      ageing: { buckets: ageing.buckets, total: ageing.total, reconciles: ageing.reconciles },
      overdueInvoices: ageing.invoices.filter((i) => i.daysOverdue > 0).slice(0, 8)
    });
  } catch (err) {
    next(err);
  }
});

// The invoice table, filtered and paged server-side so a business with
// thousands does not send them all to the browser to be searched there.
router.get('/invoicing/list', requireOrg(), async (req, res, next) => {
  try {
    const where = ['i.organization_id = $1'];
    const args = [req.orgId];
    const add = (sql, v) => { args.push(v); where.push(sql.replace(/\$n/g, '$' + args.length)); };

    const q = String(req.query.q || '').trim();
    if (q) add('(i.number ILIKE $n OR i.client_name ILIKE $n)', '%' + q + '%');
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from))) add('i.issue_date >= $n', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) add('i.issue_date <= $n', req.query.to);
    if (String(req.query.party || '').trim()) add('i.client_name ILIKE $n', '%' + String(req.query.party).trim() + '%');
    if (Number(req.query.min)) add('i.total_kobo >= $n', money.toKobo(req.query.min));
    if (Number(req.query.max)) add('i.total_kobo <= $n', money.toKobo(req.query.max));

    const paid = owed.settled('i');
    const status = String(req.query.status || 'all');
    if (status === 'draft') where.push("i.base_status = 'draft'");
    else if (status === 'void') where.push('i.voided_at IS NOT NULL');
    else {
      if (status !== 'all') where.push("i.base_status <> 'draft' AND i.voided_at IS NULL");
      if (status === 'paid') where.push(`i.total_kobo - ${paid} <= 0`);
      if (status === 'unpaid') where.push(`${paid} = 0 AND i.total_kobo > 0`);
      if (status === 'part') where.push(`${paid} > 0 AND i.total_kobo - ${paid} > 0`);
      if (status === 'overdue') where.push(`i.total_kobo - ${paid} > 0 AND i.due_date < CURRENT_DATE`);
    }

    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows, total] = await Promise.all([
      many(
        `SELECT i.id, i.number, i.client_name AS party, i.issue_date, i.due_date,
                i.total_kobo AS total, ${paid} AS paid, i.base_status, i.voided_at
           FROM invoices i WHERE ${where.join(' AND ')}
          ORDER BY i.issue_date DESC, i.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
        args
      ),
      one(`SELECT COUNT(*)::int n, COALESCE(SUM(i.total_kobo - ${paid}), 0) AS outstanding
             FROM invoices i WHERE ${where.join(' AND ')}`, args)
    ]);

    const today = new Date().toISOString().slice(0, 10);
    res.json({
      invoices: rows.map((r) => {
        const outstanding = Number(r.total) - Number(r.paid);
        return {
          id: r.id, number: r.number, party: r.party,
          issue: r.issue_date, due: r.due_date,
          total: Number(r.total), paid: Number(r.paid), outstanding,
          status: r.voided_at ? 'void'
            : r.base_status === 'draft' ? 'draft'
              : outstanding <= 0 ? 'paid'
                : r.due_date < today ? 'overdue'
                  : Number(r.paid) > 0 ? 'part' : 'unpaid'
        };
      }),
      total: total.n,
      outstanding: Number(total.outstanding),
      limit,
      offset
    });
  } catch (err) {
    next(err);
  }
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
