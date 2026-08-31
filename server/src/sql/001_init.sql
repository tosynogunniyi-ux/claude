-- =========================================================================
-- Profitna — production schema (PostgreSQL 14+)
--
-- Derived from uploads/schema.sql, extended for the shipped prototype:
-- church/fund accounting, per-book categories, bank statement lines that
-- exist without a live feed, and subscription billing.
--
-- Multi-tenant: every set of books is an `organizations` row and every
-- other table is scoped to one via organization_id. This build enforces
-- that scoping in the API layer (spec §2 Option B), so every query must
-- carry an organization_id predicate.
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  book_type            TEXT NOT NULL DEFAULT 'sme' CHECK (book_type IN ('sme', 'church')),
  business_type        TEXT NOT NULL DEFAULT 'Limited Company',
  state                TEXT,
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
  -- Null for accounts that sign in through Google and never set a password.
  password_hash        TEXT,
  full_name            TEXT,
  auth_provider        TEXT NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password', 'google')),
  google_sub           TEXT UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
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
-- SUBSCRIPTION  (14-day trial, per-seat monthly or annual)
-- Card PAN and CVV are never stored — only what the UI displays back.
-- =========================================================================

CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  cycle                TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly', 'annual')),
  seats                INTEGER NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 25),
  trial_start          DATE NOT NULL DEFAULT CURRENT_DATE,
  status               TEXT NOT NULL DEFAULT 'trialing'
                         CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  card_brand           TEXT,
  card_last4           TEXT,
  card_exp             TEXT,
  provider             TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_authorization_code TEXT,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- CATEGORIES & FUNDS  (per organization, editable; seeded on creation)
-- =========================================================================

CREATE TABLE income_categories (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (organization_id, name)
);

CREATE TABLE expense_categories (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  deductible_pct       NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (deductible_pct BETWEEN 0 AND 100),
  sort_order           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (organization_id, name)
);

-- Restricted funds for church books; unused by SME books.
CREATE TABLE funds (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  sort_order           INTEGER NOT NULL DEFAULT 0,
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
-- INVOICES (receivables; "pledges" in church books)
-- base_status is the only stored status. Paid / Part paid / Overdue are
-- derived from payments + due_date at query time, matching the prototype's
-- docStatus(). A stored computed status drifts out of sync — don't add one.
-- =========================================================================

CREATE TABLE invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               TEXT NOT NULL,
  client_id            UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Snapshot at creation: renaming or deleting a contact must never rewrite
  -- historical documents.
  client_name          TEXT NOT NULL,
  issue_date           DATE NOT NULL,
  due_date             DATE NOT NULL,
  total                NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  category             TEXT,
  fund                 TEXT,
  notes                TEXT,
  base_status          TEXT NOT NULL DEFAULT 'sent' CHECK (base_status IN ('draft', 'sent')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX idx_invoices_org ON invoices(organization_id);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date                 DATE NOT NULL,
  method               TEXT NOT NULL DEFAULT 'Bank transfer',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- =========================================================================
-- BILLS (payables)
-- =========================================================================

CREATE TABLE bills (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               TEXT NOT NULL,
  vendor_id            UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name          TEXT NOT NULL,
  issue_date           DATE NOT NULL,
  due_date             DATE NOT NULL,
  total                NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  category             TEXT,
  fund                 TEXT,
  notes                TEXT,
  base_status          TEXT NOT NULL DEFAULT 'sent' CHECK (base_status IN ('draft', 'sent')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX idx_bills_org ON bills(organization_id);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bills_due_date ON bills(due_date);
CREATE TRIGGER trg_bills_updated_at BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bill_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id              UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date                 DATE NOT NULL,
  method               TEXT NOT NULL DEFAULT 'Bank transfer',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bill_payments_bill ON bill_payments(bill_id);

-- =========================================================================
-- TRANSACTIONS (cash ledger — source of truth for dashboard, P&L, cash flow)
-- Rows with source <> 'manual' were generated by a payment, a stock move or
-- a statement import; edit them through that record, not directly.
-- =========================================================================

CREATE TABLE transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  date                 DATE NOT NULL,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  -- Empty string means "awaiting coding" — the state the AI categoriser fills.
  category             TEXT NOT NULL DEFAULT '',
  fund                 TEXT,
  party                TEXT,
  description          TEXT,
  method               TEXT NOT NULL DEFAULT 'Bank transfer',
  vat_applicable       BOOLEAN NOT NULL DEFAULT false,
  source               TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('manual', 'invoice', 'bill', 'stock', 'import', 'bank_feed')),
  ref_invoice_id       UUID REFERENCES invoices(id) ON DELETE SET NULL,
  ref_bill_id          UUID REFERENCES bills(id) ON DELETE SET NULL,
  ref_payment_id       UUID,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_org_date ON transactions(organization_id, date DESC);
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
  sku                  TEXT,
  kind                 TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service')),
  supplier             TEXT,
  location             TEXT,
  cost                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  price                NUMERIC(14,2) NOT NULL DEFAULT 0,
  qty_purchased        NUMERIC(12,2) NOT NULL DEFAULT 0,
  qty_sold             NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_level        NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty_sold <= qty_purchased)
);
CREATE INDEX idx_inventory_org ON inventory_items(organization_id);

-- =========================================================================
-- BANK FEEDS
-- Statement lines exist with or without a live connection: the CSV / Excel /
-- Sheets import path writes them with bank_connection_id NULL, and a Mono
-- feed writes them against a connection.
-- =========================================================================

CREATE TABLE bank_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'mono',
  provider_account_id  TEXT NOT NULL,
  institution_name     TEXT,
  account_number_masked TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  connected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ,
  UNIQUE (organization_id, provider_account_id)
);

CREATE TABLE bank_statement_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_connection_id   UUID REFERENCES bank_connections(id) ON DELETE CASCADE,
  provider_transaction_id TEXT,
  date                 DATE NOT NULL,
  narration            TEXT,
  -- Signed: credits positive, debits negative, as the statement reads.
  amount               NUMERIC(14,2) NOT NULL,
  matched_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  source               TEXT NOT NULL DEFAULT 'import' CHECK (source IN ('import', 'feed', 'seed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_connection_id, provider_transaction_id)
);
CREATE INDEX idx_bank_lines_org ON bank_statement_lines(organization_id, date DESC);
CREATE INDEX idx_bank_lines_matched ON bank_statement_lines(matched_transaction_id);

-- =========================================================================
-- AUDIT LOG  (who changed what — matters once more than one person signs in)
-- =========================================================================

CREATE TABLE audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  action               TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            UUID,
  detail               JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_org ON audit_log(organization_id, created_at DESC);
