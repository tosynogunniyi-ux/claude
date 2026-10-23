-- total_kobo must never be null.
--
-- Migration 007 added the column and backfilled every row correctly. Then the
-- next invoice written through the ordinary route arrived with it null,
-- because that route had not been taught about the column yet. The route is
-- fixed, but the lesson is the one worth acting on: a money column whose
-- correctness depends on every write path remembering it will eventually be
-- half-populated, and a half-populated money column is worse than none,
-- because reports will quietly read it as zero.
--
-- So the database guarantees it instead. The trigger only fills a null; it
-- never overwrites a value that was supplied, because once invoices are built
-- from line items the kobo figure is the authoritative one and `total` is
-- derived from it, not the other way round.

CREATE OR REPLACE FUNCTION invoice_total_kobo_fallback() RETURNS trigger AS $$
BEGIN
  IF NEW.total_kobo IS NULL THEN
    NEW.total_kobo := ROUND(NEW.total * 100);
  END IF;
  IF NEW.subtotal_kobo IS NULL THEN
    NEW.subtotal_kobo := NEW.total_kobo;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_total_kobo ON invoices;
CREATE TRIGGER trg_invoices_total_kobo
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_total_kobo_fallback();

-- Anything written in the window between 007 and this.
UPDATE invoices
   SET total_kobo = ROUND(total * 100)
 WHERE total_kobo IS NULL;

UPDATE invoices
   SET subtotal_kobo = total_kobo
 WHERE subtotal_kobo IS NULL;

-- Now that nothing can be null, say so. A report that reads this column no
-- longer has to decide what a missing figure means.
ALTER TABLE invoices ALTER COLUMN total_kobo SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN subtotal_kobo SET NOT NULL;
