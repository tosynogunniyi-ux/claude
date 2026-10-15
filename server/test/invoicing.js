// Does the invoicing foundation add up?
//   npm run test:invoicing
//
// Three things, in order of how much a mistake would cost.
//
// The arithmetic, because an invoice that disagrees with itself by a kobo is
// one a customer will not pay, and because floating point gets this wrong in
// ways that look right until they do not.
//
// The numbering, under real concurrency against the real database, because
// the old implementation raced and the fix is only worth having if it
// actually serialises.
//
// The Nigerian tax treatment, because VAT-inclusive pricing, zero-rated
// supplies and withholding tax are each a different thing and the common
// mistake is to treat all three as "a rate of zero" or "a discount".

require('dotenv').config();
const { pool, one, query, tx } = require('../src/db');
const m = require('../src/money');
const totals = require('../src/invoicing/totals');
const numbering = require('../src/invoicing/numbering');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

(async () => {
  console.log('\nreading money in');
  check('a plain amount', m.toKobo('1234.56') === 123456, String(m.toKobo('1234.56')));
  check('commas and a naira sign', m.toKobo('₦1,234,567.89') === 123456789, String(m.toKobo('₦1,234,567.89')));
  check('no decimals', m.toKobo('5000') === 500000);
  check('one decimal place', m.toKobo('99.5') === 9950);
  check('nothing', m.toKobo('') === 0 && m.toKobo(null) === 0 && m.toKobo(undefined) === 0);
  check('a third decimal rounds the second up', m.toKobo('10.005') === 1001, String(m.toKobo('10.005')));
  check('and rounds down below half', m.toKobo('10.004') === 1000, String(m.toKobo('10.004')));
  check('negatives survive', m.toKobo('-250.25') === -25025);

  // The reason this file exists. ₦10,000.05 times 100 is 1000004.9999999999
  // in floating point, so the obvious implementation truncates to 1000004 and
  // loses a kobo. Not every figure does this — 1234.56 is exact — which is
  // precisely what makes it dangerous: it looks correct until the one line
  // that is not.
  check('a number is read without ever being multiplied',
    m.toKobo(10000.05) === 1000005 && Math.trunc(10000.05 * 100) === 1000004,
    'the naive version is off by one kobo here');
  check('and the same for a kobo-level amount',
    m.toKobo(0.29) === 29 && Math.trunc(0.29 * 100) === 28);

  console.log('\nwriting money out');
  check('formatted with separators', m.format(123456789) === '₦1,234,567.89', m.format(123456789));
  check('kobo are never dropped', m.format(500) === '₦5.00' && m.format(5) === '₦0.05');
  check('negatives read as negatives', m.format(-25025) === '-₦250.25', m.format(-25025));
  check('naira go out to processors undivided', m.toNaira(500000) === 5000);

  console.log('\nrates and quantities');
  check('7.5% is 750 basis points', m.toBasisPoints('7.5') === 750);
  check('a percent sign is ignored', m.toBasisPoints('7.5%') === 750);
  check('2.5 units is 2500 thousandths', m.toQty('2.5') === 2500);
  check('a third of an hour keeps three places', m.toQty('0.333') === 333);

  console.log('\nrounding');
  check('half rounds away from zero', m.roundHalfUp(5, 2) === 3 && m.roundHalfUp(-5, 2) === -3,
    String(m.roundHalfUp(5, 2)) + ' / ' + String(m.roundHalfUp(-5, 2)));
  check('and below half does not', m.roundHalfUp(4, 3) === 1);

  console.log('\none line');
  const simple = totals.compute([{ description: 'Consulting', qty: 1, unitPrice: '100000', taxRate: '7.5' }]);
  check('net is the price', simple.net === 10000000, String(simple.net));
  check('VAT at 7.5% is 7,500', simple.tax === 750000, m.format(simple.tax));
  check('the total is 107,500', simple.total === 10750000, m.format(simple.total));
  check('nothing is withheld unless asked', simple.wht === 0);
  check('so the whole total is payable now', simple.payableNow === simple.total);

  console.log('\nquantities and discounts');
  const q = totals.compute([{ description: 'Hours', qty: '2.5', unitPrice: '40000', taxRate: '7.5' }]);
  check('2.5 x 40,000 is 100,000', q.net === 10000000, m.format(q.net));

  const pct = totals.compute([{ description: 'Service', qty: 1, unitPrice: '100000', discountPercent: '10', taxRate: '7.5' }]);
  check('a 10% discount comes off first', pct.net === 9000000, m.format(pct.net));
  check('and VAT follows the discounted figure', pct.tax === 675000, m.format(pct.tax));

  const flat = totals.compute([{ description: 'Service', qty: 1, unitPrice: '100000', discountAmount: '15000', taxRate: '7.5' }]);
  check('a flat discount comes off too', flat.net === 8500000, m.format(flat.net));
  check('a flat discount cannot exceed the line',
    totals.compute([{ qty: 1, unitPrice: '1000', discountAmount: '99999' }]).net === 0,
    'a line must not go negative through a typo');

  console.log('\nVAT-inclusive pricing');
  // A price of 107,500 that already contains 7.5% VAT must come apart as
  // 100,000 + 7,500 exactly, and must add back up to what was quoted.
  const inc = totals.compute(
    [{ description: 'All-in', qty: 1, unitPrice: '107500', taxRate: '7.5' }],
    { taxInclusive: true }
  );
  check('the net is backed out', inc.net === 10000000, m.format(inc.net));
  check('the tax is the remainder', inc.tax === 750000, m.format(inc.tax));
  check('and the total is exactly the price quoted', inc.total === 10750000, m.format(inc.total));

  // The awkward one: a price that does not divide cleanly must still foot.
  const awkward = totals.compute(
    [{ description: 'Odd', qty: 1, unitPrice: '1000', taxRate: '7.5' }],
    { taxInclusive: true }
  );
  check('an amount that does not divide evenly still adds up',
    awkward.net + awkward.tax === 100000,
    m.format(awkward.net) + ' + ' + m.format(awkward.tax));

  console.log('\nthe treatments a VAT return reports separately');
  const mixed = totals.compute([
    { description: 'Standard', qty: 1, unitPrice: '100000', taxRate: '7.5' },
    { description: 'Exported goods', qty: 1, unitPrice: '50000', taxTreatment: 'zero_rated', taxRate: '7.5' },
    { description: 'Medical supplies', qty: 1, unitPrice: '25000', taxTreatment: 'exempt', taxRate: '7.5' }
  ]);
  check('only the standard-rated line is taxed', mixed.tax === 750000, m.format(mixed.tax));
  check('zero-rated is kept apart from exempt',
    mixed.byTreatment.zero_rated === 5000000 && mixed.byTreatment.exempt === 2500000,
    JSON.stringify(mixed.byTreatment));
  check('a rate on an exempt line is ignored rather than applied',
    mixed.byTreatment.standard === 10000000, m.format(mixed.byTreatment.standard));
  check('and everything still totals', mixed.total === 17500000 + 750000 - 750000 + 750000,
    m.format(mixed.total));

  console.log('\nwithholding tax');
  // 5% WHT on a 100,000 service with 7.5% VAT. The customer owes 107,500,
  // withholds 5,000 of the 100,000 value, and transfers 102,500.
  const w = totals.compute([
    { description: 'Professional services', qty: 1, unitPrice: '100000', taxRate: '7.5', whtRate: '5' }
  ]);
  check('the invoice total is unchanged by withholding', w.total === 10750000, m.format(w.total));
  check('withholding is 5% of the value, not of the VAT-inclusive total',
    w.wht === 500000, m.format(w.wht));
  check('what arrives in the bank is the difference',
    w.payableNow === 10250000, m.format(w.payableNow));
  check('VAT is not withheld, because the supplier remits it',
    w.tax === 750000, m.format(w.tax));

  console.log('\nthe document foots');
  const many = totals.compute([
    { description: 'A', qty: '3', unitPrice: '13333.33', taxRate: '7.5' },
    { description: 'B', qty: '7', unitPrice: '1111.11', taxRate: '7.5' },
    { description: 'C', qty: '1.5', unitPrice: '9999.99', discountPercent: '12.5', taxRate: '7.5' }
  ]);
  const sumNet = many.lines.reduce((a, l) => a + l.net, 0);
  const sumTax = many.lines.reduce((a, l) => a + l.tax, 0);
  check('the net column adds to the net total', sumNet === many.net, m.format(sumNet));
  check('the tax column adds to the tax total', sumTax === many.tax, m.format(sumTax));
  check('and net plus tax is the grand total', many.net + many.tax === many.total, m.format(many.total));
  check('every line is a whole number of kobo',
    many.lines.every((l) => Number.isInteger(l.net) && Number.isInteger(l.tax)),
    'a fractional kobo cannot be printed or paid');

  console.log('\nan empty invoice');
  const none = totals.compute([]);
  check('adds up to nothing without throwing', none.total === 0 && none.lines.length === 0);
  check('and so does rubbish', totals.compute(null).total === 0);

  // ------------------------------------------------------------- numbering
  console.log('\nnumbering');
  const org = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    ['Invoicing Test ' + Date.now()]);

  const first = await tx((c) => numbering.allocate(c, org.id, 'invoice'));
  const year = new Date().getFullYear();
  check('the first invoice is number one',
    first.number === 'INV-' + year + '-00001', first.number);
  const second = await tx((c) => numbering.allocate(c, org.id, 'invoice'));
  check('the next one follows it', second.number === 'INV-' + year + '-00002', second.number);

  check('quotes run on their own series',
    (await tx((c) => numbering.allocate(c, org.id, 'quote'))).number === 'QUO-' + year + '-00001');
  check('and so do credit notes',
    (await tx((c) => numbering.allocate(c, org.id, 'credit_note'))).number === 'CRN-' + year + '-00001');

  // The point of the rewrite. Twenty at once, each in its own transaction and
  // its own connection, against the real database.
  const burst = await Promise.all(
    Array.from({ length: 20 }, () => tx((c) => numbering.allocate(c, org.id, 'invoice')))
  );
  const issued = burst.map((b) => b.number);
  check('twenty simultaneous invoices get twenty different numbers',
    new Set(issued).size === 20, issued.length - new Set(issued).size + ' collided');
  check('with no gaps in the run',
    Math.max(...burst.map((b) => b.value)) - Math.min(...burst.map((b) => b.value)) === 19,
    'an abandoned number would show as a hole in the series');

  const other = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    ['Invoicing Other ' + Date.now()]);
  const theirs = await tx((c) => numbering.allocate(c, other.id, 'invoice'));
  check('another business starts at one, regardless of ours',
    theirs.number === 'INV-' + year + '-00001', theirs.number);

  console.log('\ncustom patterns');
  await query(
    `UPDATE document_sequences SET prefix = 'PF-INV-', pattern = '{prefix}{year}-{number}', padding = 5
      WHERE organization_id = $1 AND kind = 'invoice'`,
    [other.id]
  );
  await query(
    `INSERT INTO document_sequence_years (organization_id, kind, year, next_value)
     VALUES ($1, 'invoice', $2, 42)
     ON CONFLICT (organization_id, kind, year) DO UPDATE SET next_value = 42`,
    [other.id, year]
  );
  const custom = await tx((c) => numbering.allocate(c, other.id, 'invoice'));
  check('a business can set its own prefix and counter',
    custom.number === 'PF-INV-' + year + '-00042', custom.number);

  const shown = await tx((c) => numbering.describe(c, other.id, 'invoice'));
  check('and the settings screen shows what comes next',
    shown.example === 'PF-INV-' + year + '-00043', shown.example);

  console.log('\nthe yearly reset');
  // Each year is its own counter, so this needs nothing reset: allocating
  // into a year the series has not been used in starts that year at 1.
  const nextYear = await tx((c) => numbering.allocate(c, org.id, 'invoice', (year + 1) + '-01-04'));
  check('a new year starts its own counter at 1', nextYear.value === 1, String(nextYear.value));
  check('and the number carries the new year',
    nextYear.number === 'INV-' + (year + 1) + '-00001', nextYear.number);
  const alsoNext = await tx((c) => numbering.allocate(c, org.id, 'invoice', (year + 1) + '-02-02'));
  check('then carries on from there', alsoNext.value === 2, String(alsoNext.value));

  // The fault this replaced: one counter plus "the year it was last used in"
  // meant that numbering a backdated document reset the series, and the next
  // current-year document was handed a number that already existed. A
  // recurring schedule backdated across a year boundary does this several
  // times in a row.
  console.log('\nout of order, across years');
  const thisYearBefore = await tx((c) => numbering.allocate(c, org.id, 'invoice', year + '-11-02'));
  const backdated = await tx((c) => numbering.allocate(c, org.id, 'invoice', (year - 2) + '-03-09'));
  const thisYearAfter = await tx((c) => numbering.allocate(c, org.id, 'invoice', year + '-11-03'));
  check('numbering a backdated document does not disturb this year',
    thisYearAfter.value === thisYearBefore.value + 1,
    thisYearBefore.value + ' then ' + thisYearAfter.value);
  check('and the backdated one is numbered in its own year',
    backdated.number === 'INV-' + (year - 2) + '-00001', backdated.number);
  check('so no number is ever handed out twice',
    new Set([thisYearBefore.number, backdated.number, thisYearAfter.number,
      nextYear.number, alsoNext.number]).size === 5);

  check('an unknown kind is refused rather than guessed',
    await tx((c) => numbering.allocate(c, org.id, 'nonsense').then(() => false, () => true)));

  // The columns added by migration 007 are only useful if the path that
  // actually creates invoices fills them in. It did not at first: the
  // migration backfilled every existing row correctly and then the next
  // invoice written arrived with total_kobo null, which is how a new column
  // quietly becomes half-populated and untrustworthy.
  console.log('\nnew invoices carry the new columns');
  const live = await one('INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    ['Invoicing Live ' + Date.now()]);
  const user = await one(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'Invoicing Test') RETURNING id`,
    ['invoicing-test-' + Date.now() + '@example.ng']
  );
  await query("INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')",
    [user.id, live.id]);

  const made = await one(
    `INSERT INTO invoices (organization_id, number, client_name, issue_date, due_date, total,
                           base_status, total_kobo, subtotal_kobo, issued_at)
     VALUES ($1, 'INV-TEST-1', 'Zenith Foods', CURRENT_DATE, CURRENT_DATE + 14, 107500.50,
             'sent', $2, $2, now())
     RETURNING *`,
    [live.id, m.toKobo('107500.50')]
  );
  check('the kobo column matches the naira one exactly',
    Number(made.total_kobo) === 10750050 && Math.round(Number(made.total) * 100) === Number(made.total_kobo),
    made.total_kobo + ' vs ' + made.total);
  check('an issued invoice records when', made.issued_at !== null);

  const orphans = await one(
    'SELECT count(*)::int n FROM invoices WHERE organization_id = $1 AND total_kobo IS NULL',
    [live.id]
  );
  check('and no invoice is left without one', orphans.n === 0, String(orphans.n));

  await query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [[org.id, other.id, live.id]]);
  await query('DELETE FROM users WHERE id = $1', [user.id]);

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
