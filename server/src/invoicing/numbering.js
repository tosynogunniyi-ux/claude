// Invoice, quote, credit note and receipt numbers.
//
// The old way read the highest number and then inserted. Two invoices created
// in the same second read the same highest, and one of them hit the unique
// constraint — safe, because the constraint is there, but the user saw an
// error for something that was nobody's mistake.
//
// This allocates by UPDATE … RETURNING instead. That takes a row lock on the
// sequence, so the second request waits for the first rather than racing it,
// and each gets its own number. The unique index stays as the backstop it
// always was.
//
// A number is allocated only when a document is issued, never on a draft. A
// draft that is abandoned should not leave a hole in the series, and a
// business that sees INV-00001 followed by INV-00007 will ask why.

const DEFAULTS = {
  invoice: { prefix: 'INV-', pattern: '{prefix}{year}-{number}', padding: 5 },
  quote: { prefix: 'QUO-', pattern: '{prefix}{year}-{number}', padding: 5 },
  credit_note: { prefix: 'CRN-', pattern: '{prefix}{year}-{number}', padding: 5 },
  receipt: { prefix: 'RCP-', pattern: '{prefix}{year}-{number}', padding: 5 }
};

const KINDS = Object.keys(DEFAULTS);

function render(row, value, year) {
  return String(row.pattern)
    .replace(/\{prefix\}/g, row.prefix || '')
    .replace(/\{year\}/g, String(year))
    .replace(/\{number\}/g, String(value).padStart(row.padding, '0'));
}

// The year a document belongs to. Taken from its own date rather than from
// the clock, so a December invoice entered in January is numbered in
// December's series.
function yearOf(when) {
  if (when && /^\d{4}-\d{2}-\d{2}/.test(String(when))) return Number(String(when).slice(0, 4));
  return (when ? new Date(when) : new Date()).getFullYear();
}

// Takes a client inside an open transaction, because allocating a number and
// writing the document that uses it must not be separable.
//
// The counter lives per year (migration 015). It used to be one counter plus
// "the year it was last used in", which reset to 1 whenever a document was
// dated into a different year — so entering a late 2025 invoice made the next
// 2026 one collide with 2026's first. A counter per year cannot do that: 2025
// and 2026 are different rows.
async function allocate(client, orgId, kind, when) {
  if (!KINDS.includes(kind)) throw new Error('numbering: unknown kind ' + kind);
  const year = yearOf(when);
  const d = DEFAULTS[kind];

  // First time for this organisation: create the settings row. ON CONFLICT DO
  // NOTHING rather than a check-then-insert, so two first invoices at once do
  // not both try to create it.
  await client.query(
    `INSERT INTO document_sequences (organization_id, kind, prefix, pattern, padding, reset_year)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, kind) DO NOTHING`,
    [orgId, kind, d.prefix, d.pattern, d.padding, year]
  );

  const settings = (await client.query(
    'SELECT prefix, pattern, padding, reset_rule FROM document_sequences WHERE organization_id = $1 AND kind = $2',
    [orgId, kind]
  )).rows[0];

  // A series set to never reset keeps one counter for all time, which is what
  // 'never' means. It is modelled as a single year bucket so there is one
  // code path and one lock.
  const bucket = settings.reset_rule === 'never' ? 0 : year;

  // One statement does the insert-or-increment and takes the row lock with
  // it, so there is no window between deciding the number and taking it. Two
  // documents created in the same second queue rather than racing, and each
  // gets its own number.
  const { rows } = await client.query(
    `INSERT INTO document_sequence_years (organization_id, kind, year, next_value)
     VALUES ($1, $2, $3, 2)
     ON CONFLICT (organization_id, kind, year) DO UPDATE
       SET next_value = document_sequence_years.next_value + 1, updated_at = now()
     RETURNING next_value - 1 AS allocated`,
    [orgId, kind, bucket]
  );

  const allocated = Number(rows[0].allocated);
  return { number: render(settings, allocated, year), value: allocated, year };
}

// What the settings screen shows and edits.
async function describe(client, orgId, kind) {
  const d = DEFAULTS[kind];
  const { rows } = await client.query(
    'SELECT * FROM document_sequences WHERE organization_id = $1 AND kind = $2',
    [orgId, kind]
  );
  const row = rows[0] || Object.assign({ next_value: 1, reset_rule: 'yearly' }, d);
  const year = new Date().getFullYear();
  // This year's counter, not the settings row's superseded one.
  const counter = (await client.query(
    'SELECT next_value FROM document_sequence_years WHERE organization_id = $1 AND kind = $2 AND year = $3',
    [orgId, kind, row.reset_rule === 'never' ? 0 : year]
  )).rows[0];
  row.next_value = counter ? Number(counter.next_value) : 1;
  return {
    kind,
    prefix: row.prefix,
    pattern: row.pattern,
    padding: row.padding,
    resetRule: row.reset_rule,
    nextValue: Number(row.next_value),
    // What the next one will actually look like — worth showing, because a
    // pattern with placeholders in it is not something to read and imagine.
    example: render(row, row.next_value, year)
  };
}

module.exports = { allocate, describe, render, yearOf, DEFAULTS, KINDS };
