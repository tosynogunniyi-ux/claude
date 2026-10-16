// Recurring invoices: the schedules, and what they have raised.
//
// Mounted inside the org-scoped router, so requireOrg has already decided
// that this caller belongs to these books. Every query is scoped by
// req.orgId regardless, because a single choke point is a policy and a
// scoped query is a guarantee.

const express = require('express');
const { one, many, tx: transaction } = require('../db');
const { requireOrg, audit } = require('../auth');
const money = require('../money');
const recurring = require('../invoicing/recurring');
const { THEMES, NAMES, DEFAULT } = require('../invoicing/themes');
const owed = require('../invoicing/outstanding');

const router = express.Router({ mergeParams: true });

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function reply(res, err, next) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

// What a schedule looks like on screen. The figures are recomputed from the
// lines rather than stored, so a schedule shows what it would actually raise
// today — including a VAT registration that happened after it was set up.
function shapeSchedule(row, lines) {
  const estimate = (lines || []).reduce(
    (a, l) => a + money.extend(Number(l.qty_milli), Number(l.unit_price_kobo)) - Number(l.discount_kobo),
    0
  );
  return {
    id: row.id,
    name: row.name,
    party: row.client_name,
    clientId: row.client_id,
    frequency: row.frequency,
    intervalCount: row.interval_count,
    // The frequency as a person would say it, so the screen does not have to
    // reassemble "every 2 weekly".
    cadence: cadenceOf(row),
    start: row.start_date,
    end: row.end_date,
    maxOccurrences: row.max_occurrences,
    nextDue: row.next_due,
    dueDays: row.due_days,
    status: row.status,
    issuedCount: row.issued_count,
    skippedCount: row.skipped_count,
    lastIssuedOn: row.last_issued_on,
    lastError: row.last_error,
    finishedReason: row.finished_reason,
    template: row.template || DEFAULT,
    notes: row.notes,
    terms: row.terms,
    purchaseOrder: row.purchase_order,
    customerReference: row.customer_reference,
    billingAddress: row.billing_address,
    estimate,
    // Said plainly, because "active" and "will actually raise something" are
    // different claims: a schedule past its end date is still marked active
    // until the next pass notices.
    willRaise: row.status === 'active' && !recurring.exhausted(row),
    lines: (lines || []).map((l) => ({
      description: l.description,
      unit: l.unit,
      qty: money.fromQty(Number(l.qty_milli)),
      unitPrice: Number(l.unit_price_kobo),
      discount: Number(l.discount_kobo),
      treatment: l.tax_treatment
    }))
  };
}

function cadenceOf(row) {
  const n = Number(row.interval_count) || 1;
  const names = { weekly: ['week', 'weeks'], monthly: ['month', 'months'], quarterly: ['quarter', 'quarters'], yearly: ['year', 'years'] };
  const [sing, plur] = names[row.frequency] || names.monthly;
  if (n === 1) return 'Every ' + sing;
  if (row.frequency === 'weekly' && n === 2) return 'Every fortnight';
  if (row.frequency === 'monthly' && n === 6) return 'Twice a year';
  return 'Every ' + n + ' ' + plur;
}

// ------------------------------------------------------------------ reading

router.get('/recurring', requireOrg(), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const where = ['r.organization_id = $1'];
    if (status === 'active' || status === 'paused' || status === 'finished') {
      where.push("r.status = '" + status + "'");
    }
    const rows = await many(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM invoices i WHERE i.recurring_invoice_id = r.id) AS raised,
              (SELECT COALESCE(SUM(i.total_kobo), 0) FROM invoices i
                WHERE i.recurring_invoice_id = r.id AND i.voided_at IS NULL) AS billed,
              (SELECT COALESCE(SUM(${owed.outstanding('i')}), 0) FROM invoices i
                WHERE i.recurring_invoice_id = r.id AND i.voided_at IS NULL
                  AND i.base_status <> 'draft') AS owing
         FROM recurring_invoices r
        WHERE ${where.join(' AND ')}
        ORDER BY r.status, r.next_due, r.created_at`,
      [req.orgId]
    );

    const lines = rows.length
      ? await many(
        `SELECT * FROM recurring_invoice_lines
          WHERE recurring_invoice_id = ANY($1) ORDER BY position`,
        [rows.map((r) => r.id)]
      )
      : [];
    const byId = new Map();
    for (const l of lines) {
      if (!byId.has(l.recurring_invoice_id)) byId.set(l.recurring_invoice_id, []);
      byId.get(l.recurring_invoice_id).push(l);
    }

    const schedules = rows.map((r) => Object.assign(
      shapeSchedule(r, byId.get(r.id) || []),
      { raised: r.raised, billed: Number(r.billed), owing: Number(r.owing) }
    ));

    res.json({
      schedules,
      active: schedules.filter((s) => s.status === 'active').length,
      // What the next month would bring in if nothing changed. An estimate and
      // said to be one: the figures are recomputed at issue time.
      monthlyValue: schedules
        .filter((s) => s.willRaise)
        .reduce((a, s) => a + perMonth(s), 0),
      dueNow: schedules.filter((s) => s.willRaise && s.nextDue <= today()).length,
      today: today()
    });
  } catch (err) { reply(res, err, next); }
});

// A schedule's value normalised to a month, so two schedules on different
// cadences can be added up. Rough by nature — a quarter is three months and a
// year is twelve, and nobody's February is 1/12 of their year.
function perMonth(s) {
  const per = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  return Math.round((s.estimate * (per[s.frequency] || 1)) / (Number(s.intervalCount) || 1));
}

router.get('/recurring/:id', requireOrg(), async (req, res, next) => {
  try {
    const row = await one(
      'SELECT * FROM recurring_invoices WHERE organization_id = $1 AND id = $2',
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such schedule.' });

    const [lines, raised] = await Promise.all([
      many('SELECT * FROM recurring_invoice_lines WHERE recurring_invoice_id = $1 ORDER BY position', [row.id]),
      many(
        `SELECT i.id, i.number, i.issue_date, i.due_date, i.total_kobo, i.base_status, i.voided_at,
                i.recurring_occurrence, ${owed.settled('i')} AS paid
           FROM invoices i
          WHERE i.organization_id = $1 AND i.recurring_invoice_id = $2
          ORDER BY i.recurring_occurrence DESC NULLS LAST, i.issue_date DESC`,
        [req.orgId, row.id]
      )
    ]);

    res.json({
      schedule: shapeSchedule(row, lines),
      // What it will raise next, before it raises it. Worth showing: a
      // schedule anchored on the 31st produces dates people want to check.
      upcoming: row.status === 'active' ? recurring.preview(row, 6) : [],
      history: raised.map((i) => ({
        id: i.id, number: i.number, issue: i.issue_date, due: i.due_date,
        total: Number(i.total_kobo), paid: Number(i.paid),
        outstanding: Number(i.total_kobo) - Number(i.paid),
        occurrence: i.recurring_occurrence,
        status: owed.statusOf({
          total: Number(i.total_kobo), settled: Number(i.paid),
          baseStatus: i.base_status, voidedAt: i.voided_at, dueDate: i.due_date
        })
      }))
    });
  } catch (err) { reply(res, err, next); }
});

// ------------------------------------------------------------------ writing

function readBody(b, existing) {
  const frequency = recurring.FREQUENCIES.includes(b.frequency) ? b.frequency
    : existing ? existing.frequency : 'monthly';
  const intervalCount = Math.min(Math.max(Number(b.intervalCount) || 1, 1), 52);
  const name = String(b.name || '').trim();
  const party = String(b.party || '').trim();

  if (!party) throw Object.assign(new Error('Choose who this bills.'), { status: 400 });
  if (!Array.isArray(b.lines) || !b.lines.length) {
    throw Object.assign(new Error('Add at least one line.'), { status: 400 });
  }
  const start = isDate(b.start) ? b.start : existing ? existing.start_date : today();
  if (b.end && !isDate(b.end)) throw Object.assign(new Error('That end date is not a date.'), { status: 400 });
  if (b.end && b.end < start) {
    throw Object.assign(new Error('The end date is before the start date.'), { status: 400 });
  }

  return {
    name: name || (party + ' — ' + frequency),
    party,
    clientId: b.clientId || null,
    frequency,
    intervalCount,
    start,
    end: b.end ? b.end : null,
    maxOccurrences: Number(b.maxOccurrences) > 0 ? Math.floor(Number(b.maxOccurrences)) : null,
    dueDays: Math.min(Math.max(Number(b.dueDays === undefined ? 14 : b.dueDays) || 0, 0), 365),
    taxInclusive: b.taxInclusive === undefined ? null : Boolean(b.taxInclusive),
    billingAddress: String(b.billingAddress || '').trim() || null,
    shippingAddress: String(b.shippingAddress || '').trim() || null,
    customerReference: String(b.customerReference || '').trim() || null,
    purchaseOrder: String(b.purchaseOrder || '').trim() || null,
    notes: String(b.notes || '').trim() || null,
    terms: String(b.terms || '').trim() || null,
    paymentInstructions: String(b.paymentInstructions || '').trim() || null,
    template: NAMES.includes(b.template) ? b.template : DEFAULT,
    category: String(b.category || '').trim() || null,
    lines: b.lines
  };
}

async function writeLines(client, scheduleId, orgId, lines) {
  await client.query('DELETE FROM recurring_invoice_lines WHERE recurring_invoice_id = $1', [scheduleId]);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    await client.query(
      `INSERT INTO recurring_invoice_lines
         (recurring_invoice_id, organization_id, position, description, item_id, unit,
          qty_milli, unit_price_kobo, discount_kobo, discount_bp, tax_treatment, tax_bp, wht_bp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [scheduleId, orgId, i,
        String(l.description || '').trim() || 'Item',
        l.itemId || null,
        String(l.unit || '').trim() || null,
        money.toQty(l.qty === undefined ? 1 : l.qty),
        money.toKobo(l.unitPrice),
        l.discountAmount === undefined || l.discountAmount === '' ? 0 : money.toKobo(l.discountAmount),
        l.discountPercent === undefined || l.discountPercent === '' ? null : money.toBasisPoints(l.discountPercent),
        ['standard', 'zero_rated', 'exempt', 'no_vat'].includes(l.taxTreatment) ? l.taxTreatment : 'standard',
        l.taxRate === undefined || l.taxRate === '' ? null : money.toBasisPoints(l.taxRate),
        l.whtRate === undefined || l.whtRate === '' ? null : money.toBasisPoints(l.whtRate)]
    );
  }
}

router.post('/recurring', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = readBody(req.body || {});
    const row = await transaction(async (client) => {
      const contact = await require('../invoicing/issue').contactFor(client, req.orgId, {
        clientId: b.clientId, party: b.party, email: (req.body || {}).email
      });
      const created = (await client.query(
        `INSERT INTO recurring_invoices
           (organization_id, name, client_id, client_name, frequency, interval_count,
            start_date, end_date, max_occurrences, next_due, due_days, tax_inclusive,
            billing_address, shipping_address, customer_reference, purchase_order,
            notes, terms, payment_instructions, template, category, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [req.orgId, b.name, contact.id, b.party, b.frequency, b.intervalCount,
          b.start, b.end, b.maxOccurrences, b.dueDays, b.taxInclusive,
          b.billingAddress, b.shippingAddress, b.customerReference, b.purchaseOrder,
          b.notes, b.terms, b.paymentInstructions, b.template, b.category, req.user.id]
      )).rows[0];
      await writeLines(client, created.id, req.orgId, b.lines);
      return created;
    });

    await audit(req.orgId, req.user.id, 'recurring.created', 'recurring_invoice', row.id,
      { name: row.name, cadence: cadenceOf(row), start: row.start_date });

    const lines = await many(
      'SELECT * FROM recurring_invoice_lines WHERE recurring_invoice_id = $1 ORDER BY position', [row.id]);
    res.status(201).json({
      schedule: shapeSchedule(row, lines),
      upcoming: recurring.preview(row, 6),
      // A start date in the past is a deliberate choice — somebody setting up
      // a retainer that began in June — and it means invoices are about to be
      // raised for every period since. Said before it happens, not after.
      note: row.next_due < today()
        ? 'The first invoice is dated ' + row.next_due + ', so the periods since then will be raised on the next pass. Press "Raise due invoices" to do it now.'
        : 'The first invoice will be raised on ' + row.next_due + '.'
    });
  } catch (err) { reply(res, err, next); }
});

router.put('/recurring/:id', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await transaction(async (client) => {
      const existing = (await client.query(
        'SELECT * FROM recurring_invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [req.orgId, req.params.id]
      )).rows[0];
      if (!existing) throw Object.assign(new Error('No such schedule.'), { status: 404 });
      const b = readBody(req.body || {}, existing);

      // The position of the schedule is not editable through the form. It
      // moves when an invoice is raised, when somebody skips a cycle, or when
      // the start date is moved on a schedule that has raised nothing yet —
      // and not otherwise, because editing it by hand is how a customer gets
      // billed twice for the same month.
      const nextDue = Number(existing.issued_count) === 0 ? b.start : existing.next_due;

      const updated = (await client.query(
        `UPDATE recurring_invoices SET
           name=$3, client_name=$4, frequency=$5, interval_count=$6, start_date=$7,
           end_date=$8, max_occurrences=$9, next_due=$10, due_days=$11, tax_inclusive=$12,
           billing_address=$13, shipping_address=$14, customer_reference=$15, purchase_order=$16,
           notes=$17, terms=$18, payment_instructions=$19, template=$20, category=$21,
           updated_at=now()
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [req.orgId, existing.id, b.name, b.party, b.frequency, b.intervalCount, b.start,
          b.end, b.maxOccurrences, nextDue, b.dueDays, b.taxInclusive,
          b.billingAddress, b.shippingAddress, b.customerReference, b.purchaseOrder,
          b.notes, b.terms, b.paymentInstructions, b.template, b.category]
      )).rows[0];
      await writeLines(client, updated.id, req.orgId, b.lines);
      return updated;
    });

    await audit(req.orgId, req.user.id, 'recurring.updated', 'recurring_invoice', row.id,
      { name: row.name });
    const lines = await many(
      'SELECT * FROM recurring_invoice_lines WHERE recurring_invoice_id = $1 ORDER BY position', [row.id]);
    res.json({ schedule: shapeSchedule(row, lines), upcoming: recurring.preview(row, 6) });
  } catch (err) { reply(res, err, next); }
});

// Pause, resume, stop. A paused schedule keeps its position: resuming does
// not raise the invoices the pause was meant to prevent, because next_due
// stayed where it was and the skip below is the only thing that moves it.
router.post('/recurring/:id/pause', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await one(
      `UPDATE recurring_invoices SET status = 'paused', paused_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND status = 'active' RETURNING *`,
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(409).json({ error: 'That schedule is not running.' });
    await audit(req.orgId, req.user.id, 'recurring.paused', 'recurring_invoice', row.id, { name: row.name });
    res.json({ schedule: shapeSchedule(row, []) });
  } catch (err) { reply(res, err, next); }
});

router.post('/recurring/:id/resume', requireOrg('accountant'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await transaction(async (client) => {
      const existing = (await client.query(
        'SELECT * FROM recurring_invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [req.orgId, req.params.id]
      )).rows[0];
      if (!existing) throw Object.assign(new Error('No such schedule.'), { status: 404 });
      if (existing.status === 'active') throw Object.assign(new Error('That schedule is already running.'), { status: 409 });

      // Resuming after a long pause: catching up would raise an invoice for
      // every month nobody was billed for, which is almost never what the
      // pause meant. `catchUp: true` is the other choice, said explicitly.
      let nextDue = existing.next_due;
      let skipped = Number(existing.skipped_count);
      if (!b.catchUp) {
        const anchor = recurring.anchorOf(existing);
        while (nextDue < today()) {
          nextDue = recurring.advance(nextDue, existing.frequency, existing.interval_count, anchor);
          skipped += 1;
        }
      }

      return (await client.query(
        `UPDATE recurring_invoices
            SET status = 'active', paused_at = NULL, finished_at = NULL, finished_reason = NULL,
                last_error = NULL, next_due = $3, skipped_count = $4, updated_at = now()
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [req.orgId, existing.id, nextDue, skipped]
      )).rows[0];
    });
    await audit(req.orgId, req.user.id, 'recurring.resumed', 'recurring_invoice', row.id,
      { name: row.name, nextDue: row.next_due, catchUp: Boolean((req.body || {}).catchUp) });
    res.json({
      schedule: shapeSchedule(row, []),
      upcoming: recurring.preview(row, 6),
      note: (req.body || {}).catchUp
        ? 'Every period since ' + row.next_due + ' will be raised on the next pass.'
        : 'Skipped the periods it was paused for. The next invoice is dated ' + row.next_due + '.'
    });
  } catch (err) { reply(res, err, next); }
});

// Skip the next one without stopping the schedule — a month a client was not
// billed for. Moves the position forward by exactly one occurrence and
// records that it was a skip rather than an issue.
router.post('/recurring/:id/skip', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await transaction(async (client) => {
      const existing = (await client.query(
        'SELECT * FROM recurring_invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [req.orgId, req.params.id]
      )).rows[0];
      if (!existing) throw Object.assign(new Error('No such schedule.'), { status: 404 });
      if (existing.status === 'finished') throw Object.assign(new Error('That schedule has finished.'), { status: 409 });
      const next = recurring.advance(existing.next_due, existing.frequency,
        existing.interval_count, recurring.anchorOf(existing));
      return (await client.query(
        `UPDATE recurring_invoices
            SET next_due = $3, skipped_count = skipped_count + 1, updated_at = now()
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [req.orgId, existing.id, next]
      )).rows[0];
    });
    await audit(req.orgId, req.user.id, 'recurring.skipped', 'recurring_invoice', row.id,
      { name: row.name, nextDue: row.next_due });
    res.json({ schedule: shapeSchedule(row, []), upcoming: recurring.preview(row, 6) });
  } catch (err) { reply(res, err, next); }
});

router.post('/recurring/:id/stop', requireOrg('accountant'), async (req, res, next) => {
  try {
    const row = await one(
      `UPDATE recurring_invoices
          SET status = 'finished', finished_at = now(), finished_reason = 'stopped', updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such schedule.' });
    await audit(req.orgId, req.user.id, 'recurring.stopped', 'recurring_invoice', row.id, { name: row.name });
    res.json({ schedule: shapeSchedule(row, []) });
  } catch (err) { reply(res, err, next); }
});

// Raise whatever is due now, rather than waiting for the hourly pass. One
// schedule when :id is given, every due schedule on these books otherwise.
router.post('/recurring/:id/run', requireOrg('accountant'), async (req, res, next) => {
  try {
    const exists = await one(
      'SELECT id, name FROM recurring_invoices WHERE organization_id = $1 AND id = $2',
      [req.orgId, req.params.id]
    );
    if (!exists) return res.status(404).json({ error: 'No such schedule.' });

    const result = await recurring.runSchedule(req.params.id, { asOf: today() });
    if (result.failed) return res.status(424).json({ error: result.failed, raised: result.raised.length });

    await audit(req.orgId, req.user.id, 'recurring.ran', 'recurring_invoice', req.params.id,
      { raised: result.raised.length });
    res.json({
      raised: result.raised.map((r) => ({
        id: r.invoice.id, number: r.invoice.number,
        issue: r.invoice.issue_date, total: Number(r.invoice.total_kobo),
        occurrence: r.occurrence
      })),
      stopped: result.stopped || null,
      capped: Boolean(result.capped)
    });
  } catch (err) { reply(res, err, next); }
});

router.post('/recurring-run', requireOrg('accountant'), async (req, res, next) => {
  try {
    const result = await recurring.run({ organizationId: req.orgId, asOf: today() });
    await audit(req.orgId, req.user.id, 'recurring.ran_all', 'organization', req.orgId,
      { invoices: result.invoices, amount: result.amount });
    res.json({
      schedules: result.schedules,
      invoices: result.invoices,
      amount: result.amount,
      failed: result.failed,
      note: result.invoices
        ? 'Raised ' + result.invoices + ' invoice' + (result.invoices === 1 ? '' : 's') +
          ' worth ' + money.format(result.amount) + '.'
        : 'Nothing was due.'
    });
  } catch (err) { reply(res, err, next); }
});

router.delete('/recurring/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    // The schedule goes; the invoices it raised stay. They were sent to a
    // customer and are in the ledger — deleting a template must not reach
    // back and unbill anybody.
    const row = await one(
      'DELETE FROM recurring_invoices WHERE organization_id = $1 AND id = $2 RETURNING id, name',
      [req.orgId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No such schedule.' });
    await audit(req.orgId, req.user.id, 'recurring.deleted', 'recurring_invoice', row.id, { name: row.name });
    res.json({ deleted: true, note: 'The invoices it already raised are untouched.' });
  } catch (err) { reply(res, err, next); }
});

module.exports = { router, shapeSchedule, cadenceOf, perMonth };
