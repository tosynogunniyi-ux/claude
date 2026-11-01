-- Invoice numbers collided across years.
--
-- `document_sequences` held one counter per (organisation, kind), plus the
-- year it was last used in. Allocating a number for a different year reset
-- that counter to 1 — correct on the 1st of January, and wrong every other
-- way it happens:
--
--   A business raises INV-2026-00001 … INV-2026-00040. Somebody then enters a
--   late invoice dated December 2025. The counter resets, hands out
--   INV-2025-00001, and sets the year to 2025. The next 2026 invoice resets
--   again and is handed INV-2026-00001 — which already exists. The unique
--   index turns that into an error, so nothing was ever mis-numbered; but the
--   business simply cannot issue an invoice until somebody works out why.
--
-- Found by a recurring schedule backdated across a year boundary, which does
-- this on purpose and several times in a row.
--
-- The fix is structural: a counter per year, so allocating for 2025 cannot
-- disturb 2026. The settings — prefix, pattern, padding, reset rule — stay on
-- the (organisation, kind) row where they belong, because they describe the
-- series and not a year of it.

CREATE TABLE IF NOT EXISTS document_sequence_years (
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  year             INTEGER NOT NULL,
  next_value       BIGINT NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind, year)
);

-- Carry across where each series had got to.
INSERT INTO document_sequence_years (organization_id, kind, year, next_value)
SELECT organization_id, kind, COALESCE(reset_year, EXTRACT(YEAR FROM now())::int), next_value
  FROM document_sequences
 WHERE reset_year IS NOT NULL OR next_value > 1
ON CONFLICT DO NOTHING;

-- And seed every other year from what is actually on the documents, so a
-- series that ran in 2024 does not start again at 1 the next time somebody
-- backdates something into it. The trailing digits of the number are the
-- counter under every pattern this product has ever produced; a number with
-- no trailing digits is a draft placeholder and is ignored.
INSERT INTO document_sequence_years (organization_id, kind, year, next_value)
SELECT organization_id, kind, year, MAX(value) + 1
  FROM (
    SELECT i.organization_id,
           'invoice'::text AS kind,
           EXTRACT(YEAR FROM i.issue_date)::int AS year,
           (substring(i.number from '([0-9]+)$'))::bigint AS value
      FROM invoices i
     WHERE i.number ~ '[0-9]$'
    UNION ALL
    SELECT n.organization_id, 'credit_note'::text,
           EXTRACT(YEAR FROM n.issue_date)::int,
           (substring(n.number from '([0-9]+)$'))::bigint
      FROM credit_notes n
     WHERE n.number ~ '[0-9]$'
    UNION ALL
    SELECT c.organization_id, 'receipt'::text,
           EXTRACT(YEAR FROM c.received_on)::int,
           (substring(c.receipt_number from '([0-9]+)$'))::bigint
      FROM customer_payments c
     WHERE c.receipt_number IS NOT NULL AND c.receipt_number ~ '[0-9]$'
  ) AS used
 GROUP BY organization_id, kind, year
ON CONFLICT (organization_id, kind, year) DO UPDATE
  -- Never move a counter backwards: if the stored one is already further on
  -- than the documents suggest, numbers were allocated and not used, and
  -- reusing them would collide.
  SET next_value = GREATEST(document_sequence_years.next_value, EXCLUDED.next_value);

-- `next_value` and `reset_year` on the settings row are no longer read. Left
-- in place rather than dropped: they are the only record of where a series
-- had got to before this ran, and dropping a column to tidy up is not worth
-- being unable to answer that question.
COMMENT ON COLUMN document_sequences.next_value IS
  'Superseded by document_sequence_years. Kept as the pre-migration position.';
COMMENT ON COLUMN document_sequences.reset_year IS
  'Superseded by document_sequence_years. Kept as the pre-migration position.';
