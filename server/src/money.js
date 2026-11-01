// Money, in integer kobo.
//
// ₦1,234.56 is 123456 here, never 1234.56. The reason is the oldest bug in
// commercial software: 1234.56 * 100 is 123455.99999999999 in IEEE 754, and
// an invoice that disagrees with itself by a kobo is an invoice a customer
// will not pay. Nothing in this file multiplies or divides a decimal.
//
// Parsing shifts the decimal point by moving characters rather than by
// arithmetic, so a typed "1,234.565" becomes 123457 by a stated rounding rule
// and not by whatever the floating point unit happened to do.
//
// Rates are in basis points: 7.5% is 750, 100% is 10000. Quantities are in
// thousandths: 2.5 hours is 2500. Both are integers for the same reason.

const KOBO = 100;
const BP = 10000;          // basis points in 100%
const QTY = 1000;          // thousandths in one unit

// Round half away from zero — the rule people expect and the one Nigerian
// invoices are read with. Banker's rounding would make 0.5 kobo differences
// alternate direction, which is defensible in statistics and indefensible in
// a line a customer is checking by hand.
function roundHalfUp(numerator, denominator) {
  if (denominator === 0) throw new Error('money: division by zero');
  const negative = (numerator < 0) !== (denominator < 0);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const result = Math.floor((n * 2 + d) / (d * 2));
  return negative ? -result : result;
}

// "₦1,234.56" | "1234.5" | 1234 | 1234.56 -> kobo.
//
// A number is accepted because callers have them, but it is turned into a
// string first and never multiplied: String(1234.56) is "1234.56" exactly,
// which is the whole point.
function toKobo(value) {
  if (value === null || value === undefined || value === '') return 0;
  let s = String(value).trim();
  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[^0-9.]/g, '');
  if (!s) return 0;

  const dot = s.indexOf('.');
  const whole = dot === -1 ? s : s.slice(0, dot);
  const fraction = dot === -1 ? '' : s.slice(dot + 1).replace(/\./g, '');

  // Two places kept, the third decides whether the second rounds up.
  const kept = (fraction + '000').slice(0, 2);
  const next = Number((fraction + '000').charAt(2));
  let kobo = Number(whole || '0') * KOBO + Number(kept);
  if (next >= 5) kobo += 1;

  if (!Number.isFinite(kobo)) return 0;
  return negative ? -kobo : kobo;
}

// Back out, for display and for anything that talks in naira — the payment
// processors, chiefly. Monnify counts in naira; Paystack counts in kobo.
const toNaira = (kobo) => Math.round(kobo) / KOBO;

function format(kobo) {
  const n = Math.round(kobo);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = String(Math.floor(abs / KOBO)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '₦' + whole + '.' + String(abs % KOBO).padStart(2, '0');
}

// "7.5" | 7.5 | "7.5%" -> 750 basis points. Four decimal places of a percent
// survive, which is more than any Nigerian rate needs and costs nothing.
function toBasisPoints(value) {
  if (value === null || value === undefined || value === '') return 0;
  let s = String(value).trim().replace(/[^0-9.-]/g, '');
  if (!s || s === '-') return 0;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const dot = s.indexOf('.');
  const whole = dot === -1 ? s : s.slice(0, dot);
  const fraction = dot === -1 ? '' : s.slice(dot + 1).replace(/\./g, '');
  const kept = (fraction + '0000').slice(0, 2);
  const next = Number((fraction + '0000').charAt(2));
  let bp = Number(whole || '0') * 100 + Number(kept);
  if (next >= 5) bp += 1;
  return negative ? -bp : bp;
}

const fromBasisPoints = (bp) => Math.round(bp) / 100;

// "2.5" | 2.5 | "2" -> 2500 thousandths.
function toQty(value) {
  if (value === null || value === undefined || value === '') return 0;
  let s = String(value).trim().replace(/[^0-9.-]/g, '');
  if (!s || s === '-') return 0;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const dot = s.indexOf('.');
  const whole = dot === -1 ? s : s.slice(0, dot);
  const fraction = dot === -1 ? '' : s.slice(dot + 1).replace(/\./g, '');
  const kept = (fraction + '0000').slice(0, 3);
  const next = Number((fraction + '0000').charAt(3));
  let q = Number(whole || '0') * QTY + Number(kept);
  if (next >= 5) q += 1;
  return negative ? -q : q;
}

const fromQty = (q) => Math.round(q) / QTY;

// quantity (thousandths) x unit price (kobo) -> kobo.
const extend = (qtyThousandths, unitKobo) => roundHalfUp(qtyThousandths * unitKobo, QTY);

// A percentage of an amount, rounded once.
const percentOf = (kobo, bp) => roundHalfUp(kobo * bp, BP);

// Tax on an amount that does NOT yet include it.
const taxOnNet = (netKobo, rateBp) => roundHalfUp(netKobo * rateBp, BP);

// Tax already inside an amount. net = gross x 10000 / (10000 + rate), and the
// tax is the remainder rather than a second rounding — so net + tax is always
// exactly the gross the customer was quoted.
function taxInGross(grossKobo, rateBp) {
  if (rateBp === 0) return { net: grossKobo, tax: 0 };
  const net = roundHalfUp(grossKobo * BP, BP + rateBp);
  return { net, tax: grossKobo - net };
}

module.exports = {
  KOBO, BP, QTY,
  roundHalfUp,
  toKobo, toNaira, format,
  toBasisPoints, fromBasisPoints,
  toQty, fromQty,
  extend, percentOf, taxOnNet, taxInGross
};
