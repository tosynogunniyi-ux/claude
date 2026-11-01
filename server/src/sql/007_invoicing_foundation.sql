-- Smart Invoicing 2.0, the foundation everything else sits on.
--
-- Additive only. No existing column changes type, no existing row is
-- rewritten, and an invoice created before this migration keeps working: its
-- `total` is still the figure of record until somebody edits it, at which
-- point lines are written and the total becomes their sum.

-- ---------------------------------------------------------------- identity
--
-- Six fields an invoice must carry that the organisation had nowhere to keep.
-- Nullable on purpose: an existing business has not been asked for them, and
-- an invoice should be issuable before every one is filled in.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address        TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website        TEXT;
-- Tax Identification Number, and the CAC registration number.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tin            TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS rc_number      TEXT;
-- Whether this business charges VAT at all. A business below the registration
-- threshold must not have 7.5% quietly applied to its invoices, which is what
-- a bare vat_rate column invites.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS vat_registered BOOLEAN NOT NULL DEFAULT false;
-- Prices as typed: do they already include VAT?
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS prices_include_vat BOOLEAN NOT NULL DEFAULT false;
-- Default withholding rate for this business's customers, in basis points.
-- 0 means none, which is the right default: WHT applies to specified
-- services and specified payers, not to every sale.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_wht_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_terms  TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

-- ------------------------------------------------------------ invoice body
--
-- Money is stored in integer kobo in these columns, not NUMERIC naira. The
-- existing invoices.total stays NUMERIC naira so nothing already written
-- changes meaning; the two are reconciled when an invoice is saved.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal_kobo  BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_kobo  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_kobo       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_kobo     BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS wht_kobo       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_inclusive  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'NGN';
-- Who it is for, beyond the snapshotted name.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_address  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipping_address TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_reference TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS purchase_order   TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms            TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_instructions TEXT;
-- The lifecycle. base_status already holds draft/sent and is what every
-- existing screen reads, so it is left exactly as it is; this records the
-- parts it cannot express.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at     TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS void_reason   TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS template      TEXT NOT NULL DEFAULT 'executive';

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- Carried so a line can never be read without its tenant, and so the
  -- isolation check is the same one every other table gets.
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  -- Snapshotted, like client_name: renaming or deleting a product must never
  -- rewrite an invoice that has already been issued.
  description          TEXT NOT NULL,
  item_id              UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  unit                 TEXT,
  -- Thousandths of a unit: 2.5 hours is 2500.
  qty_milli            BIGINT NOT NULL DEFAULT 1000,
  unit_price_kobo      BIGINT NOT NULL DEFAULT 0,
  discount_kobo        BIGINT NOT NULL DEFAULT 0,
  tax_treatment        TEXT NOT NULL DEFAULT 'standard'
                         CHECK (tax_treatment IN ('standard', 'zero_rated', 'exempt', 'no_vat')),
  -- Basis points: 7.5% is 750.
  tax_bp               INTEGER NOT NULL DEFAULT 0,
  wht_bp               INTEGER NOT NULL DEFAULT 0,
  net_kobo             BIGINT NOT NULL DEFAULT 0,
  tax_kobo             BIGINT NOT NULL DEFAULT 0,
  wht_kobo             BIGINT NOT NULL DEFAULT 0,
  total_kobo           BIGINT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id, position);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_org ON invoice_lines(organization_id);

-- ------------------------------------------------------------- numbering
--
-- One row per organisation per series. The number is allocated by UPDATE …
-- RETURNING, which takes a row lock, so two invoices created at the same
-- instant queue rather than both reading the same highest value. The existing
-- UNIQUE (organization_id, number) stays as the backstop.

CREATE TABLE IF NOT EXISTS document_sequences (
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'invoice', 'quote', 'credit_note', 'receipt'
  kind                 TEXT NOT NULL,
  prefix               TEXT NOT NULL DEFAULT '',
  -- {number} is replaced by the padded counter, {year} by the calendar year.
  pattern              TEXT NOT NULL DEFAULT '{prefix}{year}-{number}',
  padding              INTEGER NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 12),
  next_value           BIGINT NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  -- 'never' | 'yearly': whether the counter restarts in January.
  reset_rule           TEXT NOT NULL DEFAULT 'yearly' CHECK (reset_rule IN ('never', 'yearly')),
  reset_year           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind)
);

-- -------------------------------------------------------------- lifecycle
--
-- Append-only. Nothing here is ever updated or deleted, so the timeline on an
-- invoice is a record rather than a rendering of the current state.

CREATE TABLE IF NOT EXISTS invoice_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- created | finalised | sent | viewed | reminder_sent | payment_recorded
  -- | paid | voided
  event                TEXT NOT NULL,
  -- Who, when a person did it. Null for a customer view or a scheduled job.
  actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  detail               JSONB,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id, occurred_at);

-- Backfill: every invoice that already exists was created, and the ones that
-- are not drafts were issued. Without this their timelines would start empty
-- and look like data loss.
INSERT INTO invoice_events (invoice_id, organization_id, event, occurred_at)
SELECT i.id, i.organization_id, 'created', i.created_at
  FROM invoices i
 WHERE NOT EXISTS (SELECT 1 FROM invoice_events e WHERE e.invoice_id = i.id AND e.event = 'created');

INSERT INTO invoice_events (invoice_id, organization_id, event, occurred_at)
SELECT i.id, i.organization_id, 'finalised', i.created_at
  FROM invoices i
 WHERE i.base_status <> 'draft'
   AND NOT EXISTS (SELECT 1 FROM invoice_events e WHERE e.invoice_id = i.id AND e.event = 'finalised');

UPDATE invoices SET issued_at = created_at WHERE base_status <> 'draft' AND issued_at IS NULL;

-- Existing invoices have a total and no lines. Recording it in kobo now means
-- every read path can use one column rather than asking which era an invoice
-- is from.
UPDATE invoices
   SET total_kobo = ROUND(total * 100),
       subtotal_kobo = ROUND(total * 100)
 WHERE total_kobo IS NULL;
