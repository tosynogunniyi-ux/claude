-- A receipt belongs in the cash book, and an allocation belongs in kobo.
--
-- Three things 011 left for the database to guarantee rather than for every
-- future write path to remember. The pattern is the one 008 established: a
-- BEFORE trigger fills what a caller omitted, the backfill repairs anything
-- already written, and only then does the column become NOT NULL — because a
-- money column that is right on most rows is worse than one that is absent,
-- a report reading a missing figure as zero rather than as unknown.

-- ------------------------------------------- allocations, in integer kobo
--
-- invoice_payments.amount is NUMERIC naira and has been since the first
-- migration. Postgres arithmetic on NUMERIC is exact, so the column is not
-- wrong — but `pg` hands it to JavaScript as a float, and the one place that
-- must never happen is the figure that decides whether an invoice is settled.
-- So the kobo integer becomes the authoritative column and naira is kept
-- beside it, in step, for every query and every screen that already reads it.

ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS amount_kobo BIGINT;

CREATE OR REPLACE FUNCTION invoice_payment_guarantees() RETURNS trigger AS $$
BEGIN
  -- Whichever one the caller supplied decides; kobo wins if both are given,
  -- because it is the one with no rounding left in it.
  IF NEW.amount_kobo IS NULL THEN
    NEW.amount_kobo := ROUND(NEW.amount * 100);
  ELSE
    NEW.amount := NEW.amount_kobo::numeric / 100;
  END IF;

  -- An allocation that does not say which business it belongs to can be read
  -- from the invoice it is against. Scoping a query by tenant is how every
  -- other table in this schema is kept apart, and an unscopeable row is a
  -- row that will eventually be counted into somebody else's books.
  IF NEW.organization_id IS NULL AND NEW.invoice_id IS NOT NULL THEN
    SELECT i.organization_id INTO NEW.organization_id
      FROM invoices i WHERE i.id = NEW.invoice_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_payment_guarantees ON invoice_payments;
CREATE TRIGGER trg_invoice_payment_guarantees
  BEFORE INSERT OR UPDATE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION invoice_payment_guarantees();

UPDATE invoice_payments SET amount_kobo = ROUND(amount * 100) WHERE amount_kobo IS NULL;
UPDATE invoice_payments p SET organization_id = i.organization_id
  FROM invoices i WHERE i.id = p.invoice_id AND p.organization_id IS NULL;

-- An allocation whose invoice has been deleted cannot be scoped and cannot be
-- reached from any screen. There is none at the time of writing; if one ever
-- appears, it is removed rather than left to make the column nullable
-- forever — the money it recorded is in the cash book regardless.
DELETE FROM invoice_payments WHERE organization_id IS NULL;

-- 011 put a DEFERRABLE constraint trigger on this table, so the three
-- statements above leave trigger events queued until commit — and Postgres
-- will not alter a table with events pending against it. Firing them now
-- empties the queue, and if one of them were going to fail it is better that
-- it fails here, inside the migration, than at commit.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE invoice_payments ALTER COLUMN amount_kobo SET NOT NULL;
ALTER TABLE invoice_payments ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_org ON invoice_payments(organization_id, date DESC);

-- 011 wrote this trigger against the naira column, before the kobo one
-- existed. Same rule, read from the authoritative figure.
CREATE OR REPLACE FUNCTION allocation_within_payment() RETURNS trigger AS $$
DECLARE
  parent UUID;
  total BIGINT;
  cap BIGINT;
BEGIN
  parent := COALESCE(NEW.customer_payment_id, OLD.customer_payment_id);
  IF parent IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount_kobo), 0) INTO total
    FROM invoice_payments WHERE customer_payment_id = parent;
  SELECT amount_kobo INTO cap FROM customer_payments WHERE id = parent;
  -- The payment itself may have been deleted in this same transaction, which
  -- cascades its allocations away. Nothing to check, and no cap to check it
  -- against.
  IF cap IS NULL THEN RETURN NULL; END IF;
  IF total > cap THEN
    RAISE EXCEPTION 'allocations of % kobo exceed the % kobo received', total, cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------- a receipt in the cash book
--
-- A customer payment has to appear in the cash book, or the business cannot
-- reconcile its bank statement against Profitna — the figure would be in the
-- receivables report and nowhere a statement line could be matched to it.
--
-- So one cash-book row per receipt, pointing back at it. 'receipt' is a new
-- source because its ledger entry is not the same as an invoice payment's:
-- part of a receipt may be money received in advance, which settles no
-- receivable and is a liability until it is allocated.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ref_customer_payment_id UUID
  REFERENCES customer_payments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(ref_customer_payment_id);

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('manual', 'invoice', 'bill', 'stock', 'import', 'bank_feed', 'receipt'));

-- A credit note is not cash and gets no cash-book row. It still needs a
-- journal entry, and 009's source_type list has to admit it.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('manual', 'invoice', 'bill', 'payment', 'transaction',
                         'opening', 'adjustment', 'stock', 'credit_note', 'receipt'));
