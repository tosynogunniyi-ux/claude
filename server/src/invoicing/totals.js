// What an invoice adds up to.
//
// The browser computes this too, so the figures move as somebody types. This
// is the copy that counts: the one the invoice is saved from, the one the
// customer is charged, the one the books record. A client that disagrees is
// simply overruled, which is why nothing here trusts a total that arrived in
// a request body.
//
// Everything is integer kobo (src/money.js). Rounding happens once per line
// and the document totals are sums of already-rounded lines, so an invoice
// always foots: the column adds up to the figure printed under it.
//
// Nigerian specifics worth stating, because they are where this differs from
// a generic invoice calculator:
//
// VAT is 7.5% at the time of writing, but it is never assumed — a rate comes
// from the line, the organisation or the request, and zero-rated and exempt
// are distinct states rather than "rate 0", because a VAT return reports them
// on different lines.
//
// Withholding tax is NOT a reduction of the invoice. The customer owes the
// full amount; they are required to withhold a percentage, pay that to the
// revenue service, and remit the rest. So the invoice total is unchanged and
// a separate "amount payable now" is what lands in the bank. Treating WHT as
// a discount — which is the common mistake — understates revenue and leaves
// the receivable permanently short.

const m = require('../money');

const TREATMENTS = ['standard', 'zero_rated', 'exempt', 'no_vat'];

const treatmentOf = (v) => (TREATMENTS.includes(String(v)) ? String(v) : 'standard');

// One line, from whatever the request called things, to integers.
function readLine(raw, defaults) {
  const r = raw || {};
  const d = defaults || {};
  const treatment = treatmentOf(r.taxTreatment || d.taxTreatment || 'standard');

  return {
    description: String(r.description || '').trim().slice(0, 500),
    itemId: r.itemId || null,
    unit: String(r.unit || '').trim().slice(0, 24) || null,
    qty: m.toQty(r.qty === undefined ? 1 : r.qty),
    unitPrice: m.toKobo(r.unitPrice),
    // A percentage discount when discountPercent is given, otherwise a flat
    // amount. Both can be absent; they are not added together.
    discountBp: r.discountPercent === undefined || r.discountPercent === ''
      ? null : m.toBasisPoints(r.discountPercent),
    discountFlat: r.discountAmount === undefined || r.discountAmount === ''
      ? 0 : m.toKobo(r.discountAmount),
    treatment,
    // Only a standard-rated line carries a rate. Zero-rated and exempt are
    // reported separately on a VAT return and must not be collapsed into 0%.
    taxBp: treatment === 'standard'
      ? m.toBasisPoints(r.taxRate === undefined || r.taxRate === '' ? d.taxRate : r.taxRate)
      : 0,
    whtBp: r.whtRate === undefined || r.whtRate === ''
      ? m.toBasisPoints(d.whtRate || 0) : m.toBasisPoints(r.whtRate)
  };
}

// One line's arithmetic. Rounded here and nowhere else.
function computeLine(line, taxInclusive) {
  const gross = m.extend(line.qty, line.unitPrice);

  const discount = line.discountBp !== null
    ? m.percentOf(gross, line.discountBp)
    : Math.min(line.discountFlat, Math.max(gross, 0));

  const afterDiscount = gross - discount;

  let net = afterDiscount;
  let tax = 0;
  if (line.treatment === 'standard' && line.taxBp > 0) {
    if (taxInclusive) {
      const split = m.taxInGross(afterDiscount, line.taxBp);
      net = split.net;
      tax = split.tax;
    } else {
      tax = m.taxOnNet(afterDiscount, line.taxBp);
    }
  }

  // Withholding is computed on the net of tax — the value of the supply —
  // not on the VAT-inclusive total. VAT is not withheld; it is remitted by
  // the supplier.
  const wht = line.whtBp > 0 ? m.percentOf(net, line.whtBp) : 0;

  return {
    description: line.description,
    itemId: line.itemId,
    unit: line.unit,
    qty: line.qty,
    unitPrice: line.unitPrice,
    treatment: line.treatment,
    taxBp: line.taxBp,
    whtBp: line.whtBp,
    discount,
    net,
    tax,
    wht,
    total: net + tax
  };
}

// The whole document.
//
// `options.taxInclusive` says whether the unit prices already contain VAT.
// `options.taxRate` and `options.whtRate` are the organisation's defaults,
// applied to any line that does not state its own.
function compute(rawLines, options) {
  const o = options || {};
  const taxInclusive = Boolean(o.taxInclusive);
  const defaults = { taxRate: o.taxRate, whtRate: o.whtRate, taxTreatment: o.taxTreatment };

  const lines = (Array.isArray(rawLines) ? rawLines : [])
    .map((raw) => computeLine(readLine(raw, defaults), taxInclusive));

  const sum = (pick) => lines.reduce((a, l) => a + pick(l), 0);

  const net = sum((l) => l.net);
  const tax = sum((l) => l.tax);
  const wht = sum((l) => l.wht);
  const discount = sum((l) => l.discount);
  const total = net + tax;

  // Split out for the VAT return, which reports these on separate lines.
  const byTreatment = {
    standard: sum((l) => (l.treatment === 'standard' ? l.net : 0)),
    zero_rated: sum((l) => (l.treatment === 'zero_rated' ? l.net : 0)),
    exempt: sum((l) => (l.treatment === 'exempt' ? l.net : 0)),
    no_vat: sum((l) => (l.treatment === 'no_vat' ? l.net : 0))
  };

  return {
    lines,
    taxInclusive,
    discount,
    net,
    tax,
    total,
    wht,
    // What the customer actually transfers when they withhold. The invoice is
    // still owed in full; the difference arrives as a credit note from the
    // revenue service rather than as cash.
    payableNow: total - wht,
    byTreatment,
    currency: 'NGN'
  };
}

// For the screen and the PDF: the same figures, formatted once, here, so an
// invoice shows the same string everywhere it is rendered.
function presentable(t) {
  return {
    discount: m.format(t.discount),
    net: m.format(t.net),
    tax: m.format(t.tax),
    total: m.format(t.total),
    wht: m.format(t.wht),
    payableNow: m.format(t.payableNow)
  };
}

module.exports = { compute, computeLine, readLine, presentable, TREATMENTS };
