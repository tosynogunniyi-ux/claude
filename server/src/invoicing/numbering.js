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

// Takes a client inside an open transaction, because allocating a number and
// writing the document that uses it must not be separable.
async function allocate(client, orgId, kind, when) {
  if (!KINDS.includes(kind)) throw new Error('numbering: unknown kind ' + kind);
  const year = (when ? new Date(when) : new Date()).getFullYear();
  const d = DEFAULTS[kind];

  // First time for this organisation: create the sequence. ON CONFLICT DO
  // NOTHING rather than a check-then-insert, so two first invoices at once
  // do not both try to create it.
  await client.query(
    `INSERT INTO document_sequences (organization_id, kind, prefix, pattern, padding, reset_year)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, kind) DO NOTHING`,
    [orgId, kind, d.prefix, d.pattern, d.padding, year]
  );

  // One statement does the lock, the yearly reset and the increment, so there
  // is no window between deciding the number and taking it.
  const { rows } = await client.query(
    `UPDATE document_sequences
        SET next_value = CASE
              WHEN reset_rule = 'yearly' AND COALESCE(reset_year, $3) <> $3 THEN 2
              ELSE next_value + 1
            END,
            reset_year = $3,
            updated_at = now()
      WHERE organization_id = $1 AND kind = $2
      RETURNING prefix, pattern, padding, reset_rule, reset_year,
                CASE
                  WHEN reset_rule = 'yearly' AND COALESCE(reset_year, $3) <> $3 THEN 1
                  ELSE next_value - 1
                END AS allocated`,
    [orgId, kind, year]
  );

  const row = rows[0];
  return { number: render(row, row.allocated, year), value: Number(row.allocated), year };
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

module.exports = { allocate, describe, render, DEFAULTS, KINDS };
