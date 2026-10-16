-- Release 2: taking money in, allocating it, and giving it back.
--
-- The rule this release is built around: **Profitna is the platform, not the
-- intermediary.** A tenant's customer pays that tenant's own merchant
-- account. Nothing a customer pays passes through Profitna's balance, and
-- the credentials that make that true are stored per organisation — never
-- shared with the ones that collect Profitna's own subscription fees.
--
-- Note what is NOT created here. `payments` already exists and is Profitna's
-- own subscription income; it is untouched. `invoice_payments` already exists
-- and is already an allocation — one row is money against one invoice — so it
-- is extended with a parent rather than replaced. Every existing row stays
-- valid and means exactly what it meant before.

-- ------------------------------------------------- a tenant's own merchant

CREATE TABLE IF NOT EXISTS merchant_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('paystack', 'monnify')),
  environment          TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
  -- Public by design: a Paystack public key or a Monnify API key reaches the
  -- browser and cannot authorise anything on its own.
  public_key           TEXT,
  contract_code        TEXT,
  -- Encrypted at rest with CREDENTIALS_KEY (src/crypto.js). The column holds
  -- ciphertext, never a readable key, and no endpoint returns it.
  secret_cipher        TEXT,
  -- Each organisation gets its own webhook path segment, so one tenant cannot
  -- post events onto another's account by guessing an id.
  webhook_token        TEXT NOT NULL,
  -- Nothing is live until the credentials have been proved against the
  -- provider. "Saved" and "works" are different claims.
  verified_at          TIMESTAMPTZ,
  last_error           TEXT,
  active               BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_webhook_token ON merchant_accounts(webhook_token);

-- ------------------------------------------------------- money coming in

CREATE TABLE IF NOT EXISTS customer_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Snapshotted, like every other party name here: renaming a customer must
  -- not rewrite a receipt that has already been sent.
  party                TEXT NOT NULL,
  client_id            UUID REFERENCES clients(id) ON DELETE SET NULL,
  received_on          DATE NOT NULL,
  amount_kobo          BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency             TEXT NOT NULL DEFAULT 'NGN',
  -- 'bank_transfer' | 'cash' | 'pos' | 'cheque' | 'card' | 'other'
  method               TEXT NOT NULL DEFAULT 'bank_transfer',
  -- How it was established that the money arrived. A gateway-verified payment
  -- and one somebody typed in are both real, and the difference matters when
  -- a figure is disputed — so it is recorded rather than inferred.
  source               TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('manual', 'gateway')),
  provider             TEXT,
  provider_reference   TEXT,
  reference            TEXT,
  bank_account_id      UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  receipt_number       TEXT,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'received'
                         CHECK (status IN ('pending', 'received', 'failed', 'reversed', 'refunded')),
  settled_at           TIMESTAMPTZ,
  fee_kobo             BIGINT NOT NULL DEFAULT 0,
  recorded_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_payments_org ON customer_payments(organization_id, received_on DESC);
-- One provider reference is one payment. A replayed webhook, a retried verify
-- and a double-clicked button all collapse onto the same row rather than
-- crediting a customer twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_payments_provider_ref
  ON customer_payments(organization_id, provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- invoice_payments is already the allocation: one row, one invoice, one
-- amount. It gains a parent so several allocations can belong to one receipt,
-- and a receipt can be larger than any one invoice. Existing rows have no
-- parent, which is exactly what they are — a standalone allocation.
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS customer_payment_id UUID
  REFERENCES customer_payments(id) ON DELETE CASCADE;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS organization_id UUID
  REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_invoice_payments_parent ON invoice_payments(customer_payment_id);

-- Backfill the tenant onto allocations that predate the column, so every
-- lookup can be scoped the same way as everything else.
UPDATE invoice_payments p SET organization_id = i.organization_id
  FROM invoices i WHERE i.id = p.invoice_id AND p.organization_id IS NULL;

-- ------------------------------------------------------- money going back

CREATE TABLE IF NOT EXISTS credit_notes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               TEXT NOT NULL,
  client_id            UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name          TEXT NOT NULL,
  -- What it corrects, when it corrects one thing. A credit note may also
  -- stand alone, which is why this is nullable.
  invoice_id           UUID REFERENCES invoices(id) ON DELETE SET NULL,
  issue_date           DATE NOT NULL,
  reason               TEXT,
  subtotal_kobo        BIGINT NOT NULL DEFAULT 0,
  tax_kobo             BIGINT NOT NULL DEFAULT 0,
  total_kobo           BIGINT NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'void')),
  issued_at            TIMESTAMPTZ,
  voided_at            TIMESTAMPTZ,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org ON credit_notes(organization_id, issue_date DESC);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id       UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  description          TEXT NOT NULL,
  qty_milli            BIGINT NOT NULL DEFAULT 1000,
  unit_price_kobo      BIGINT NOT NULL DEFAULT 0,
  tax_treatment        TEXT NOT NULL DEFAULT 'standard'
                         CHECK (tax_treatment IN ('standard', 'zero_rated', 'exempt', 'no_vat')),
  tax_bp               INTEGER NOT NULL DEFAULT 0,
  net_kobo             BIGINT NOT NULL DEFAULT 0,
  tax_kobo             BIGINT NOT NULL DEFAULT 0,
  total_kobo           BIGINT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines ON credit_note_lines(credit_note_id, position);

-- A credit note applied to an invoice reduces what is owed on it, the same
-- way a payment does — but it is not a payment and no cash moved, so it is
-- kept apart rather than written into invoice_payments where it would show
-- up as money received.
CREATE TABLE IF NOT EXISTS credit_note_applications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id       UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount_kobo          BIGINT NOT NULL CHECK (amount_kobo > 0),
  applied_on           DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cn_applications ON credit_note_applications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_cn_applications_note ON credit_note_applications(credit_note_id);

-- ------------------------------------------------- two rules the DB keeps
--
-- An allocation may not exceed its payment, and a credit note may not be
-- applied for more than it is worth. Both are checked in code with a row
-- lock, and both are checked again here — because the code is not the only
-- thing that will ever write to these tables, and over-allocating money is
-- the kind of mistake that is discovered months later by a customer.

CREATE OR REPLACE FUNCTION allocation_within_payment() RETURNS trigger AS $$
DECLARE
  parent UUID;
  total BIGINT;
  cap BIGINT;
BEGIN
  parent := COALESCE(NEW.customer_payment_id, OLD.customer_payment_id);
  IF parent IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(ROUND(amount * 100)), 0) INTO total
    FROM invoice_payments WHERE customer_payment_id = parent;
  SELECT amount_kobo INTO cap FROM customer_payments WHERE id = parent;
  IF total > cap THEN
    RAISE EXCEPTION 'allocations of % kobo exceed the % kobo received', total, cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_allocation_within_payment ON invoice_payments;
CREATE CONSTRAINT TRIGGER trg_allocation_within_payment
  AFTER INSERT OR UPDATE OR DELETE ON invoice_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION allocation_within_payment();

CREATE OR REPLACE FUNCTION credit_within_note() RETURNS trigger AS $$
DECLARE
  note UUID;
  total BIGINT;
  cap BIGINT;
BEGIN
  note := COALESCE(NEW.credit_note_id, OLD.credit_note_id);
  SELECT COALESCE(SUM(amount_kobo), 0) INTO total
    FROM credit_note_applications WHERE credit_note_id = note;
  SELECT total_kobo INTO cap FROM credit_notes WHERE id = note;
  IF cap IS NOT NULL AND total > cap THEN
    RAISE EXCEPTION 'applications of % kobo exceed the % kobo credit note', total, cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_within_note ON credit_note_applications;
CREATE CONSTRAINT TRIGGER trg_credit_within_note
  AFTER INSERT OR UPDATE OR DELETE ON credit_note_applications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_within_note();
