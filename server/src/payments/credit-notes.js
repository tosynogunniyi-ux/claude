// Correcting an invoice that has already been sent.
//
// An issued invoice is not editable in Profitna, and that is not an
// inconvenience to be worked around — it is the point. The customer has a
// copy, the VAT has been recognised, and the figure is in a filed return. The
// correction is a second document that says what changed and by how much, and
// both stay in the record.
//
// A credit note reduces the receivable the moment it is issued. Which invoice
// it is applied to is a separate decision and posts nothing: the credit
// exists against the customer either way, so applying it to invoice 7 rather
// than invoice 9 moves nothing in the general ledger. Getting that wrong — a
// journal entry on application as well as on issue — would credit the
// receivable twice, and the trial balance would still balance.

const money = require('../money');
const totals = require('../invoicing/totals');
const numbering = require('../invoicing/numbering');
const gl = require('../accounting/post');
const owed = require('../invoicing/outstanding');

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// A credit note built from the invoice it corrects, so the figures and the
// VAT treatment are the invoice's own rather than typed again. What the
// builder offers when somebody presses "Credit this invoice".
async function fromInvoice(client, orgId, invoiceId) {
  const { rows } = await client.query(
    `SELECT i.*, ${owed.paid('i')} AS paid_kobo, ${owed.credited('i')} AS credited_kobo
       FROM invoices i WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, invoiceId]
  );
  const invoice = rows[0];
  if (!invoice) throw fail(404, 'No such invoice.');
  if (invoice.base_status === 'draft') {
    throw fail(409, 'That invoice is still a draft. Change it instead of crediting it.');
  }

  const lines = (await client.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position, created_at', [invoiceId]
  )).rows;

  // Already credited once: what is left to credit is the invoice less what
  // has been credited, not the invoice again.
  const creditable = Number(invoice.total_kobo) - Number(invoice.credited_kobo);

  return {
    invoiceId: invoice.id,
    number: invoice.number,
    party: invoice.client_name,
    clientId: invoice.client_id,
    issueDate: invoice.issue_date,
    total: Number(invoice.total_kobo),
    paid: Number(invoice.paid_kobo),
    alreadyCredited: Number(invoice.credited_kobo),
    creditable,
    taxInclusive: invoice.tax_inclusive,
    // Shaped the way invoicing/totals.js reads a line — the same shape the
    // invoice builder posts — so this can be handed straight back to issue()
    // without a second translation that could disagree with the first. The
    // integers come back out of compute(); what goes in is what a person
    // would have typed.
    lines: lines.length
      ? lines.map((l) => ({
        description: l.description,
        unit: l.unit,
        qty: money.fromQty(Number(l.qty_milli)),
        unitPrice: money.toNaira(Number(l.unit_price_kobo)),
        taxTreatment: l.tax_treatment,
        taxRate: money.fromBasisPoints(Number(l.tax_bp))
      }))
      : [{
        description: 'Credit against ' + invoice.number,
        unit: null, qty: 1, unitPrice: money.toNaira(creditable),
        taxTreatment: 'no_vat', taxRate: 0
      }]
  };
}

// Issue one. Draft credit notes are allowed and allocate no number, for the
// same reason a draft invoice does not: an abandoned draft must not leave a
// hole in a series a tax inspector will read.
async function issue(client, {
  orgId, userId, invoiceId, party, clientId, issueDate, reason, lines, status = 'issued', applyNow
}) {
  const wantsDraft = status === 'draft';
  const on = isDate(issueDate) ? issueDate : today();

  let invoice = null;
  if (invoiceId) {
    const { rows } = await client.query(
      `SELECT i.*, ${owed.credited('i')} AS credited_kobo
         FROM invoices i WHERE i.organization_id = $1 AND i.id = $2 FOR UPDATE OF i`,
      [orgId, invoiceId]
    );
    invoice = rows[0];
    if (!invoice) throw fail(404, 'No such invoice.');
    if (invoice.base_status === 'draft') {
      throw fail(409, 'That invoice is still a draft. Change it instead of crediting it.');
    }
  }

  const name = String(party || (invoice && invoice.client_name) || '').trim();
  if (!name) throw fail(400, 'Say who the credit note is for.');
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Add at least one line.');

  const org = (await client.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows[0];
  const computed = totals.compute(lines, {
    taxInclusive: invoice ? invoice.tax_inclusive : org.prices_include_vat,
    taxRate: org.vat_registered ? org.vat_rate : 0,
    taxTreatment: org.vat_registered ? 'standard' : 'no_vat',
    // A credit note reverses revenue. Withholding tax was the customer's
    // deduction from what they paid, not part of what was earned, so it has
    // no place here and is forced off rather than inherited from the invoice.
    whtRate: 0
  });

  if (!wantsDraft && computed.total <= 0) {
    throw fail(400, 'This credit note totals nothing. Add an amount before issuing it.');
  }

  // A credit note for more than the invoice it corrects is almost always a
  // mistyped figure, and it would leave a customer with a credit nobody
  // intended to give them.
  if (invoice && !wantsDraft) {
    const room = Number(invoice.total_kobo) - Number(invoice.credited_kobo);
    if (computed.total > room) {
      throw fail(400,
        'Invoice ' + invoice.number + ' has ' + money.format(room) + ' left to credit, so a ' +
        money.format(computed.total) + ' credit note cannot be issued against it.');
    }
  }

  let contact = clientId || (invoice && invoice.client_id) || null;
  if (!contact) {
    const found = (await client.query(
      'SELECT id FROM clients WHERE organization_id = $1 AND lower(name) = lower($2)', [orgId, name]
    )).rows[0];
    contact = found ? found.id : null;
  }

  const number = wantsDraft
    ? 'DRAFT-' + Date.now().toString(36).toUpperCase()
    : (await numbering.allocate(client, orgId, 'credit_note', on)).number;

  const note = (await client.query(
    `INSERT INTO credit_notes
       (organization_id, number, client_id, client_name, invoice_id, issue_date, reason,
        subtotal_kobo, tax_kobo, total_kobo, status, issued_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [orgId, number, contact, name, invoice ? invoice.id : null, on,
      String(reason || '').trim() || null,
      computed.net, computed.tax, computed.total,
      wantsDraft ? 'draft' : 'issued', wantsDraft ? null : new Date().toISOString(), userId || null]
  )).rows[0];

  for (let i = 0; i < computed.lines.length; i++) {
    const l = computed.lines[i];
    await client.query(
      `INSERT INTO credit_note_lines
         (credit_note_id, organization_id, position, description, qty_milli, unit_price_kobo,
          tax_treatment, tax_bp, net_kobo, tax_kobo, total_kobo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [note.id, orgId, i, l.description || 'Credit', l.qty, l.unitPrice,
        l.treatment, l.taxBp, l.net, l.tax, l.total]
    );
  }

  if (wantsDraft) return { note, totals: computed, applied: [] };

  await gl.creditNoteIssued(client, {
    orgId,
    note,
    lines: computed.lines.map((l) => ({ description: l.description, net: l.net })),
    userId
  });

  // Set against the invoice it corrects straight away, which is what somebody
  // crediting a particular invoice meant. A standalone credit note is left
  // unapplied as money on the customer's account.
  const applied = [];
  if (invoice && applyNow !== false) {
    applied.push(await apply(client, {
      orgId, userId, noteId: note.id, invoiceId: invoice.id, amountKobo: computed.total, on
    }));
  }

  return { note, totals: computed, applied };
}

// Set a credit against an invoice. No journal entry: issuing the note already
// credited the receivable, and this says which invoice stops being owed.
async function apply(client, { orgId, noteId, invoiceId, amountKobo, on }) {
  const { rows } = await client.query(
    `SELECT n.*, ${owed.unapplied('n')} AS unapplied
       FROM credit_notes n WHERE n.organization_id = $1 AND n.id = $2 FOR UPDATE OF n`,
    [orgId, noteId]
  );
  const note = rows[0];
  if (!note) throw fail(404, 'No such credit note.');
  if (note.status !== 'issued') {
    throw fail(409, 'A ' + note.status + ' credit note cannot be applied.');
  }

  const available = Number(note.unapplied);
  if (available <= 0) throw fail(409, 'All of that credit note has already been applied.');

  const invoiceRows = await client.query(
    `SELECT i.*, ${owed.paid('i')} AS paid_kobo, ${owed.credited('i')} AS credited_kobo
       FROM invoices i WHERE i.organization_id = $1 AND i.id = $2 FOR UPDATE OF i`,
    [orgId, invoiceId]
  );
  const invoice = invoiceRows.rows[0];
  if (!invoice) throw fail(404, 'No such invoice.');
  if (invoice.voided_at) throw fail(409, 'Invoice ' + invoice.number + ' has been voided.');
  if (invoice.base_status === 'draft') {
    throw fail(409, 'Invoice ' + invoice.number + ' is still a draft.');
  }
  if (note.client_id && invoice.client_id && note.client_id !== invoice.client_id) {
    throw fail(400, 'That credit note belongs to a different customer.');
  }

  const outstanding = Number(invoice.total_kobo) - Number(invoice.paid_kobo) - Number(invoice.credited_kobo);
  const wanted = amountKobo === undefined || amountKobo === null
    ? Math.min(available, outstanding) : Math.round(Number(amountKobo));
  if (wanted <= 0) throw fail(400, 'Enter how much of the credit to apply.');
  if (wanted > available) {
    throw fail(400, 'Only ' + money.format(available) + ' of that credit note is left.');
  }
  if (wanted > outstanding) {
    throw fail(400,
      'Invoice ' + invoice.number + ' only has ' + money.format(outstanding) +
      ' outstanding, so ' + money.format(wanted) + ' cannot be credited against it.');
  }

  const row = (await client.query(
    `INSERT INTO credit_note_applications
       (credit_note_id, invoice_id, organization_id, amount_kobo, applied_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [noteId, invoiceId, orgId, wanted, isDate(on) ? on : today()]
  )).rows[0];

  return { application: row, invoiceNumber: invoice.number, amount: wanted };
}

// Withdrawn. The entry is reversed rather than deleted, and the applications
// go with it so the invoices it reduced are owed again.
async function voidNote(client, { orgId, userId, noteId, reason, on }) {
  const { rows } = await client.query(
    'SELECT * FROM credit_notes WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, noteId]
  );
  const note = rows[0];
  if (!note) throw fail(404, 'No such credit note.');
  if (note.status === 'void') throw fail(409, 'That credit note has already been voided.');

  if (note.status === 'issued') {
    const entry = (await client.query(
      `SELECT id FROM journal_entries
        WHERE organization_id = $1 AND source_key = $2 AND reversal_of IS NULL`,
      [orgId, 'creditnote:' + noteId + ':issue']
    )).rows[0];
    if (entry) {
      await gl.reverse(client, {
        orgId, entryId: entry.id, date: isDate(on) ? on : today(), userId,
        memo: 'Credit note ' + note.number + ' voided' + (reason ? ' — ' + reason : '')
      });
    }
  }

  await client.query('DELETE FROM credit_note_applications WHERE credit_note_id = $1', [noteId]);

  return (await client.query(
    `UPDATE credit_notes SET status = 'void', voided_at = now(), reason =
        CASE WHEN $3 = '' THEN reason ELSE COALESCE(reason || ' / ', '') || 'Voided: ' || $3 END
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, noteId, String(reason || '').trim()]
  )).rows[0];
}

module.exports = { fromInvoice, issue, apply, voidNote };
