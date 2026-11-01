// Writing an invoice. The only place that does.
//
// This was the builder route's inner transaction, and it stayed there happily
// while the builder was the only thing that wrote an invoice. It is not any
// more: a recurring schedule raises one every month without a person in the
// loop, and the two paths must produce an identical row — same totals, same
// lines, same ledger entry, same events, same series.
//
// Copying forty lines of INSERT into the generator would have worked on the
// day it was written and then drifted, the way `backfill.pending()` drifted
// when it was written twice. So the builder calls this, the generator calls
// this, and whatever calls it next calls this.
//
// Takes a client inside an open transaction, because an invoice, its lines,
// its events and its journal entry are one event.

const money = require('../money');
const numbering = require('./numbering');
const totals = require('./totals');
const gl = require('../accounting/post');
const { NAMES, DEFAULT } = require('./themes');

const DRAFT = 'draft';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// The organisation's own defaults, read inside the transaction so a VAT
// registration changed a second ago applies to this invoice.
async function organisationDefaults(client, orgId) {
  const { rows } = await client.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
  const org = rows[0];
  if (!org) throw fail(404, 'No such organisation.');
  return {
    org,
    taxInclusive: org.prices_include_vat,
    // A business below the VAT registration threshold must not have 7.5%
    // quietly applied because a default said so.
    taxRate: org.vat_registered ? org.vat_rate : 0,
    taxTreatment: org.vat_registered ? 'standard' : 'no_vat',
    whtRate: money.fromBasisPoints(org.default_wht_bp || 0)
  };
}

// One shared customer list. A name that already exists is reused rather than
// quietly creating a second record with the same name.
async function contactFor(client, orgId, { clientId, party, email, phone }) {
  if (clientId) {
    const found = (await client.query(
      'SELECT * FROM clients WHERE organization_id = $1 AND id = $2', [orgId, clientId]
    )).rows[0];
    if (found) return found;
  }
  const name = String(party || '').trim();
  const existing = (await client.query(
    'SELECT * FROM clients WHERE organization_id = $1 AND lower(name) = lower($2)', [orgId, name]
  )).rows[0];
  if (existing) return existing;
  return (await client.query(
    'INSERT INTO clients (organization_id, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *',
    [orgId, name, String(email || '').trim() || null, String(phone || '').trim() || null]
  )).rows[0];
}

// Create or update an invoice from typed line inputs.
//
// `existingId` reopens a draft. `recurring` ties the invoice to the schedule
// that raised it, and `occurrence` is which one it is — the pair has a unique
// index behind it, so a generator that runs twice cannot raise the same
// month twice however it is interrupted.
async function write(client, {
  orgId, userId, body, existingId, recurring = null, occurrence = null, source = 'builder'
}) {
  const b = body || {};
  const wantsDraft = b.status === DRAFT;
  const partyName = String(b.party || '').trim();
  if (!partyName) throw fail(400, 'Choose who this invoice is for.');
  if (!Array.isArray(b.lines) || !b.lines.length) throw fail(400, 'Add at least one line.');

  const defaults = await organisationDefaults(client, orgId);
  const computed = totals.compute(b.lines, {
    taxInclusive: b.taxInclusive === undefined ? defaults.taxInclusive : Boolean(b.taxInclusive),
    taxRate: defaults.taxRate,
    taxTreatment: defaults.taxTreatment,
    whtRate: defaults.whtRate
  });

  // An invoice that adds up to nothing is a mistake, not a document.
  if (!wantsDraft && computed.total <= 0) {
    throw fail(400, 'This invoice totals nothing. Add an amount before issuing it.');
  }

  const contact = await contactFor(client, orgId, {
    clientId: b.clientId, party: partyName, email: b.email, phone: b.phone
  });

  const existing = existingId
    ? (await client.query(
      'SELECT * FROM invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, existingId]
    )).rows[0]
    : null;
  if (existingId && !existing) throw fail(404, 'No such invoice.');
  // Issued invoices are not editable. A finalised document is corrected with a
  // credit note, not by changing what was sent to the customer.
  if (existing && existing.base_status !== DRAFT) {
    throw fail(409, 'This invoice has been issued. Issue a credit note to change it.');
  }

  const issueDate = isDate(b.issue) ? b.issue : today();
  const dueDate = isDate(b.due) ? b.due : issueDate;

  // The number is allocated only when the invoice is issued, so an abandoned
  // draft leaves no hole in the series.
  const number = existing && existing.number && existing.base_status !== DRAFT
    ? existing.number
    : wantsDraft
      ? (existing ? existing.number : 'DRAFT-' + Date.now().toString(36).toUpperCase())
      : (await numbering.allocate(client, orgId, 'invoice', issueDate)).number;

  const fields = [
    orgId, number, contact.id, partyName, issueDate, dueDate,
    money.toNaira(computed.total),
    computed.net, computed.discount, computed.tax, computed.total, computed.wht,
    computed.taxInclusive,
    wantsDraft ? DRAFT : 'sent',
    String(b.billingAddress || '').trim() || null,
    String(b.shippingAddress || '').trim() || null,
    String(b.customerReference || '').trim() || null,
    String(b.purchaseOrder || '').trim() || null,
    String(b.notes || '').trim() || null,
    String(b.terms || '').trim() || null,
    String(b.paymentInstructions || '').trim() || null,
    NAMES.includes(b.template) ? b.template : DEFAULT,
    wantsDraft ? null : new Date().toISOString(),
    recurring,
    occurrence
  ];

  let invoice;
  if (existing) {
    invoice = (await client.query(
      `UPDATE invoices SET number=$2, client_id=$3, client_name=$4, issue_date=$5, due_date=$6,
              total=$7, subtotal_kobo=$8, discount_kobo=$9, tax_kobo=$10, total_kobo=$11, wht_kobo=$12,
              tax_inclusive=$13, base_status=$14, billing_address=$15, shipping_address=$16,
              customer_reference=$17, purchase_order=$18, notes=$19, terms=$20,
              payment_instructions=$21, template=$22, issued_at=COALESCE(issued_at,$23),
              recurring_invoice_id=COALESCE($24, recurring_invoice_id),
              recurring_occurrence=COALESCE($25, recurring_occurrence)
         WHERE organization_id=$1 AND id=$26 RETURNING *`,
      fields.concat([existing.id])
    )).rows[0];
    await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [existing.id]);
  } else {
    invoice = (await client.query(
      `INSERT INTO invoices (organization_id, number, client_id, client_name, issue_date, due_date,
              total, subtotal_kobo, discount_kobo, tax_kobo, total_kobo, wht_kobo, tax_inclusive,
              base_status, billing_address, shipping_address, customer_reference, purchase_order,
              notes, terms, payment_instructions, template, issued_at,
              recurring_invoice_id, recurring_occurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      fields
    )).rows[0];
  }

  for (let i = 0; i < computed.lines.length; i++) {
    const l = computed.lines[i];
    await client.query(
      `INSERT INTO invoice_lines (invoice_id, organization_id, position, description, item_id, unit,
              qty_milli, unit_price_kobo, discount_kobo, tax_treatment, tax_bp, wht_bp,
              net_kobo, tax_kobo, wht_kobo, total_kobo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [invoice.id, orgId, i, l.description || 'Item', l.itemId || null, l.unit,
        l.qty, l.unitPrice, l.discount, l.treatment, l.taxBp, l.whtBp,
        l.net, l.tax, l.wht, l.total]
    );
  }

  await client.query(
    `INSERT INTO invoice_events (invoice_id, organization_id, event, actor_user_id, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [invoice.id, orgId, existing ? 'updated' : 'created', userId || null,
      JSON.stringify({ total: computed.total, lines: computed.lines.length, source })]
  );

  // Into the ledger on issue, never on a draft: a draft is not a receivable
  // and must not appear in anybody's revenue.
  if (!wantsDraft) {
    await client.query(
      `INSERT INTO invoice_events (invoice_id, organization_id, event, actor_user_id, detail)
       VALUES ($1,$2,'finalised',$3,$4)`,
      [invoice.id, orgId, userId || null, JSON.stringify({ source })]
    );
    await gl.invoiceIssued(client, {
      orgId,
      invoice,
      lines: computed.lines.map((l) => ({
        description: l.description, net: l.net, category: b.category
      })),
      totals: computed,
      userId
    });
  }

  return { invoice, computed, contact, created: !existing };
}

module.exports = { write, organisationDefaults, contactFor, DRAFT };
