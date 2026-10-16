-- Invoices that raise themselves.
--
-- A retainer billed on the 1st of every month is the same invoice twelve
-- times, and typing it twelve times is twelve chances to type it differently.
-- This holds the template and the schedule; the generator
-- (src/invoicing/recurring.js) turns it into real invoices through the same
-- code path the builder uses, so a generated invoice and a typed one are the
-- same kind of row.

CREATE TABLE IF NOT EXISTS recurring_invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- What the business calls it on screen. Not the invoice number — these
  -- never have one; the invoices they raise take numbers from the ordinary
  -- series, in the order they are actually issued.
  name                 TEXT NOT NULL,
  client_id            UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Snapshotted like everywhere else: renaming a customer must not rewrite
  -- the invoices already raised, and the schedule keeps billing the party it
  -- was set up for.
  client_name          TEXT NOT NULL,

  frequency            TEXT NOT NULL DEFAULT 'monthly'
                         CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  -- Every N of those. 2 + 'weekly' is fortnightly; 6 + 'monthly' is
  -- half-yearly. One field fewer than a list of named periods, and it covers
  -- the ones nobody thought to name.
  interval_count       INTEGER NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 52),

  start_date           DATE NOT NULL,
  -- Either may be set, neither need be. A schedule with no end runs until
  -- somebody stops it, which is what a retainer is.
  end_date             DATE,
  max_occurrences      INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),

  -- When the next one is due.
  --
  -- Stored, which is against the grain of this schema — document status,
  -- balances, trial ends and ledger figures are all derived at read time
  -- precisely so they cannot go stale. This one is stored on purpose, and the
  -- reason is that it is not derivable: once a human has paused a schedule for
  -- two months or skipped a cycle, where the schedule stands is a record of
  -- decisions, not arithmetic on the start date. Deriving it would silently
  -- raise the two invoices the pause was meant to prevent.
  --
  -- It only ever moves forward, and only inside the transaction that raises
  -- the invoice it was pointing at.
  next_due             DATE NOT NULL,
  -- Net terms: the generated invoice is due this many days after it is
  -- issued. 0 means due on receipt.
  due_days             INTEGER NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 0 AND 365),

  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'paused', 'finished')),
  paused_at            TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  -- Why it stopped, for the screen: 'ended' (past end_date), 'completed'
  -- (hit max_occurrences), or 'stopped' (somebody stopped it).
  finished_reason      TEXT,

  issued_count         INTEGER NOT NULL DEFAULT 0,
  skipped_count        INTEGER NOT NULL DEFAULT 0,
  last_issued_on       DATE,
  -- What went wrong last time, if anything. A schedule whose books are closed
  -- or whose figures no longer add up stops rather than failing silently once
  -- a month forever.
  last_error           TEXT,
  last_run_at          TIMESTAMPTZ,

  -- The invoice this raises, minus the dates and the number.
  tax_inclusive        BOOLEAN,
  billing_address      TEXT,
  shipping_address     TEXT,
  customer_reference   TEXT,
  purchase_order       TEXT,
  notes                TEXT,
  terms                TEXT,
  payment_instructions TEXT,
  template             TEXT,
  category             TEXT,

  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_org ON recurring_invoices(organization_id, status, next_due);
-- The generator's own query: every schedule anywhere that is due. Partial, so
-- it stays small however many paused and finished ones accumulate.
CREATE INDEX IF NOT EXISTS idx_recurring_due
  ON recurring_invoices(next_due) WHERE status = 'active';

-- The lines, as typed rather than as computed. Totals are worked out again
-- every time one is raised, so a VAT registration that happened last week
-- reaches next month's invoice instead of being frozen at setup.
CREATE TABLE IF NOT EXISTS recurring_invoice_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_invoice_id UUID NOT NULL REFERENCES recurring_invoices(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  description          TEXT NOT NULL,
  item_id              UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  unit                 TEXT,
  qty_milli            BIGINT NOT NULL DEFAULT 1000,
  unit_price_kobo      BIGINT NOT NULL DEFAULT 0,
  discount_kobo        BIGINT NOT NULL DEFAULT 0,
  discount_bp          INTEGER,
  tax_treatment        TEXT NOT NULL DEFAULT 'standard'
                         CHECK (tax_treatment IN ('standard', 'zero_rated', 'exempt', 'no_vat')),
  tax_bp               INTEGER,
  wht_bp               INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_lines
  ON recurring_invoice_lines(recurring_invoice_id, position);

-- Which schedule raised an invoice, and which occurrence it was.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_invoice_id UUID
  REFERENCES recurring_invoices(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_occurrence INTEGER;
CREATE INDEX IF NOT EXISTS idx_invoices_recurring
  ON invoices(recurring_invoice_id, recurring_occurrence);

-- The guarantee that stops a customer being billed twice for March.
--
-- The generator advances next_due inside the same transaction that writes the
-- invoice, which is already enough on its own. This is the backstop for
-- everything that is not the generator: two containers racing, a run retried
-- after a timeout, somebody pressing "Run now" twice, a restore that replays
-- a partial transaction log. Duplicate billing is the characteristic failure
-- of recurring invoicing and the only reliable defence is a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_recurring_once
  ON invoices(recurring_invoice_id, recurring_occurrence)
  WHERE recurring_invoice_id IS NOT NULL;
