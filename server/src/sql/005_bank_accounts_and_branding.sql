-- =========================================================================
-- Profitna — bank accounts, and a company's own branding on its reports
--
-- organizations.opening_cash was one figure for the whole business, which is
-- fine until you have two accounts and need to know what is in each. Bank
-- accounts now own that number: opening_cash becomes the sum of their opening
-- balances, kept in step by the API, so every existing report, KPI and cash
-- series keeps working without knowing anything changed.
-- =========================================================================

CREATE TABLE bank_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  bank_name            TEXT,
  -- The company's own account, the one already printed on their invoices.
  account_number       TEXT,
  opening_balance      NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- What the opening balance is the balance *at*. Anything before this date
  -- is assumed to be inside it rather than on top of it.
  opening_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Where a bank payment lands when nobody says which account it used.
  is_primary           BOOLEAN NOT NULL DEFAULT false,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  archived_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bank_accounts_org ON bank_accounts(organization_id, sort_order);

-- At most one primary account per organisation, enforced rather than hoped for.
CREATE UNIQUE INDEX idx_bank_accounts_primary
  ON bank_accounts (organization_id)
  WHERE is_primary AND archived_at IS NULL;

CREATE TRIGGER trg_bank_accounts_updated_at BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which account a payment moved through. Null means it never touched a bank —
-- cash in hand — so a cash sale does not silently inflate a bank balance.
ALTER TABLE transactions
  ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_transactions_bank_account ON transactions(bank_account_id);

-- -------------------------------------------------------------------------
-- Carry existing books across
-- -------------------------------------------------------------------------

-- Every organisation that already has books gets one account holding the
-- opening cash it already had, so no figure on any screen moves.
INSERT INTO bank_accounts (organization_id, name, opening_balance, opening_date, is_primary, sort_order)
SELECT o.id, 'Main account', o.opening_cash, o.created_at::date, true, 0
  FROM organizations o;

-- And every payment that went through a bank is attributed to it, so the
-- account's current balance is right from the first time it is looked at.
UPDATE transactions t
   SET bank_account_id = b.id
  FROM bank_accounts b
 WHERE b.organization_id = t.organization_id
   AND b.is_primary
   AND t.method IN ('Bank transfer', 'Card', 'Cheque', 'POS', 'Transfer');

-- -------------------------------------------------------------------------
-- Branding
-- -------------------------------------------------------------------------

-- Held in the database rather than on disk: the app runs in a container with
-- no persistent volume, and a logo that disappears on the next deploy is
-- worse than none.
ALTER TABLE organizations
  ADD COLUMN logo            BYTEA,
  ADD COLUMN logo_mime       TEXT,
  ADD COLUMN logo_updated_at TIMESTAMPTZ;
