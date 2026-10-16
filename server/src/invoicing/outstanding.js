// What an invoice still owes, defined once.
//
// Before this release there was one way to reduce an invoice: pay it. Now
// there are two, because a credit note reduces what is owed without any money
// moving. That makes "outstanding" a sum of three things, and a definition
// that lives in fourteen separate SQL strings will eventually mean fourteen
// slightly different numbers on fourteen screens — the dashboard saying a
// customer owes ₦40,000 while the statement says ₦25,000, with no way to tell
// which is right.
//
// So every query that needs it composes these fragments instead. They are SQL
// text rather than a view because they appear inside aggregates, filters and
// ORDER BY clauses in a dozen queries, and a view would make each of those a
// join with its own correlation to get right.
//
// Each takes the alias the invoice table is under in the calling query.

// Money actually received and allocated against this invoice, in kobo.
// amount_kobo, not ROUND(amount * 100): the kobo column is the authoritative
// one as of migration 012 and does not travel through a float on the way to
// JavaScript.
const paid = (i = 'i') =>
  `COALESCE((SELECT SUM(p.amount_kobo) FROM invoice_payments p WHERE p.invoice_id = ${i}.id), 0)`;

// Credit notes applied to this invoice. Only issued ones count — a draft
// credit note is a thought, and a voided one has been withdrawn.
const credited = (i = 'i') =>
  `COALESCE((SELECT SUM(a.amount_kobo) FROM credit_note_applications a
               JOIN credit_notes n ON n.id = a.credit_note_id
              WHERE a.invoice_id = ${i}.id AND n.status = 'issued'), 0)`;

// Both together: everything that has reduced the balance, however it did so.
const settled = (i = 'i') => `(${paid(i)} + ${credited(i)})`;

// What is left. May be negative, and that is not an error: a customer who has
// overpaid is owed money, and rounding it up to zero would hide it.
const outstanding = (i = 'i') => `(${i}.total_kobo - ${settled(i)})`;

// How much of a receipt has not yet been put against an invoice. Money
// received in advance is a liability, not revenue and not a payment, and this
// is the figure that says how much of it there is.
const unallocated = (c = 'c') =>
  `(${c}.amount_kobo - COALESCE((SELECT SUM(p.amount_kobo) FROM invoice_payments p
                                  WHERE p.customer_payment_id = ${c}.id), 0))`;

// How much of a credit note has not yet been applied to anything.
const unapplied = (n = 'n') =>
  `(${n}.total_kobo - COALESCE((SELECT SUM(a.amount_kobo) FROM credit_note_applications a
                                 WHERE a.credit_note_id = ${n}.id), 0))`;

// The status a document is in, worked out from its dates and its balance
// rather than read from a column — the same rule the whole product follows,
// because a stored status is only correct until the next midnight nothing ran.
function statusOf({ total, settled: paidOff, baseStatus, voidedAt, dueDate }, today) {
  if (voidedAt) return 'void';
  if (baseStatus === 'draft') return 'draft';
  const left = Number(total) - Number(paidOff);
  if (left <= 0) return 'paid';
  const day = today || new Date().toISOString().slice(0, 10);
  if (dueDate && String(dueDate) < day) return 'overdue';
  return Number(paidOff) > 0 ? 'part' : 'unpaid';
}

module.exports = { paid, credited, settled, outstanding, unallocated, unapplied, statusOf };
