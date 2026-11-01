-- =========================================================================
-- Business Finance Manager — Production Schema (PostgreSQL 14+)
-- Multi-tenant: every business is an `organizations` row; every other table
-- is scoped to one via organization_id. Mirrors the prototype's data model
-- field-for-field so the CSV exports already in the prototype map cleanly.
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- housekeeping: auto-maintained updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- TENANCY & AUTH
-- =========================================================================

CREATE TABLE organizations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  business_type        TEXT NOT NULL DEFAULT 'Sole Proprietorship / Partnership'
                         CHECK (business_type IN ('Sole Proprietorship / Partnership', 'Limited Company')),
  state                TEXT,
  vat_registered       BOOLEAN NOT NULL DEFAULT false,
  vat_rate             NUMERIC(5,2) NOT NULL DEFAULT 7.5,
  opening_cash         NUMERIC(14,2) NOT NULL DEFAULT 0,
  owner_contributions  NUMERIC(14,2) NOT NULL DEFAULT 0,
  fixed_assets         NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,          -- omit entirely if delegating auth to Supabase Auth / an IdP
  full_name            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL DEFAULT 'accountant' CHECK (role IN ('admin', 'accountant', 'viewer')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX idx_memberships_org ON memberships(organization_id);

-- =========================================================================
-- CATEGORIES  (per-organization, editable — seed from the prototype's
-- TAX RULES-derived defaults on organization creation)
-- =========================================================================

CREATE TABLE income_categories (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE expense_categories (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  deductible_pct       NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (deductible_pct BETWEEN 0 AND 100),
  UNIQUE (organization_id, name)
);

-- =========================================================================
-- CONTACTS
-- =========================================================================

CREATE TABLE clients (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  address              TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_org ON clients(organization_id);

CREATE TABLE vendors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  address              TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vendors_org ON vendors(organization_id);

-- =========================================================================
-- INVOICES (Accounts Receivable)
-- Base status is only 'draft' | 'sent' — Paid / Partially Paid / Overdue
-- are DERIVED from payments + due_date at query time (see api/reports
-- notes below), exactly as in the prototype. Do not add a stored
-- "computed" status column; it will drift out of sync.
-- =========================================================================

CREATE TABLE invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               TEXT NOT NULL,
  client_id            UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name          TEXT NOT NULL,           -- snapshot at creation; invoices must not silently change if the client record is later renamed
  issue_date           DATE NOT NULL,
  due_date             DATE NOT NULL,
  category             TEXT,                     -- revenue category, for P&L / tax mapping
  tax_rate             NUMERIC(5,2) NOT NULL DEFAULT 0,
  notes                TEXT,
  prepared_by          TEXT,
  base_status          TEXT NOT NULL DEFAULT 'draft' CHECK (base_status IN ('draft', 'sent')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX idx_invoices_org ON invoices(organization_id);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description          TEXT NOT NULL,
  qty                  NUMERIC(12,2) NOT NULL DEFAULT 1,
  price                NUMERIC(14,2) NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE invoice_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date                 DATE NOT NULL,
  method               TEXT NOT NULL DEFAULT 'Transfer',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- =========================================================================
-- BILLS (Accounts Payable)
-- =========================================================================

CREATE TABLE bills (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               TEXT NOT NULL,
  vendor_id            UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name          TEXT NOT NULL,
  category             TEXT,
  issue_date           DATE NOT NULL,
  due_date             DATE NOT NULL,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX idx_bills_org ON bills(organization_id);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bills_due_date ON bills(due_date);

CREATE TABLE bill_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id              UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date                 DATE NOT NULL,
  method               TEXT NOT NULL DEFAULT 'Transfer',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bill_payments_bill ON bill_payments(bill_id);

-- =========================================================================
-- TRANSACTIONS (cash ledger — the source of truth for Dashboard/P&L/Cash Flow)
-- A row with source <> 'manual' was auto-generated by an invoice/bill
-- payment; edit or delete it via that payment, not directly, to keep the
-- linked record in sync (mirrors the prototype's UI rule).
-- =========================================================================

CREATE TABLE transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  date                 DATE NOT NULL,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category             TEXT NOT NULL,
  party                TEXT,
  description          TEXT,
  method               TEXT NOT NULL DEFAULT 'Transfer',
  vat_applicable       BOOLEAN NOT NULL DEFAULT false,
  source               TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'invoice', 'bill', 'bank_feed')),
  ref_invoice_id       UUID REFERENCES invoices(id) ON DELETE SET NULL,
  ref_bill_id          UUID REFERENCES bills(id) ON DELETE SET NULL,
  ref_payment_id       UUID,                      -- invoice_payments.id or bill_payments.id, depending on source
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_org_date ON transactions(organization_id, date);
CREATE INDEX idx_transactions_category ON transactions(organization_id, category);
CREATE INDEX idx_transactions_ref_invoice ON transactions(ref_invoice_id);
CREATE INDEX idx_transactions_ref_bill ON transactions(ref_bill_id);

-- =========================================================================
-- PRODUCTS & SERVICES
-- =========================================================================

CREATE TABLE inventory_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service')),
  description          TEXT,
  category             TEXT,
  cost_per_unit        NUMERIC(14,2) NOT NULL DEFAULT 0,
  supplier             TEXT,
  location             TEXT,
  qty_purchased        NUMERIC(12,2) NOT NULL DEFAULT 0,
  qty_sold             NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_level        NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty_sold <= qty_purchased)
);
CREATE INDEX idx_inventory_org ON inventory_items(organization_id);

-- =========================================================================
-- LOANS
-- =========================================================================

CREATE TABLE loans (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lender_name          TEXT NOT NULL,
  amount               NUMERIC(14,2) NOT NULL,
  loan_date            DATE,
  repayment_start      DATE,
  interest_rate        NUMERIC(5,2) DEFAULT 0,
  frequency            TEXT DEFAULT 'Monthly',
  outstanding_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  next_payment_due     DATE,
  repayment_amount     NUMERIC(14,2) DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'Active',
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_loans_org ON loans(organization_id);

-- =========================================================================
-- BANK FEEDS  (Mono — see spec doc §5; Okra is defunct, do not integrate it)
-- =========================================================================

CREATE TABLE bank_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'mono',
  provider_account_id  TEXT NOT NULL,             -- Mono's account id from the Connect widget
  institution_name     TEXT,
  account_number_masked TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  connected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ,
  UNIQUE (organization_id, provider_account_id)
);

CREATE TABLE bank_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_connection_id   UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  provider_transaction_id TEXT NOT NULL,
  date                 DATE NOT NULL,
  description          TEXT,
  amount               NUMERIC(14,2) NOT NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  matched_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_connection_id, provider_transaction_id)
);
CREATE INDEX idx_bank_transactions_connection ON bank_transactions(bank_connection_id);
CREATE INDEX idx_bank_transactions_matched ON bank_transactions(matched_transaction_id);

-- =========================================================================
-- AUDIT LOG  (who changed what — matters once more than one person can log in)
-- =========================================================================

CREATE TABLE audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  action               TEXT NOT NULL,             -- e.g. 'invoice.payment_recorded'
  entity_type          TEXT NOT NULL,
  entity_id            UUID,
  detail               JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_org ON audit_log(organization_id, created_at DESC);

-- =========================================================================
-- ROW LEVEL SECURITY  (enable if hosting on Supabase — see spec §2, Option A)
-- If you build a custom backend instead (Option B), skip this block and
-- enforce the same organization_id scoping in your API/service layer.
-- =========================================================================

-- ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
-- -- ...repeat for every tenant-scoped table...
-- CREATE POLICY org_isolation ON transactions
--   USING (organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid()));
-- -- repeat the same USING clause (adjusted table name) for each table
