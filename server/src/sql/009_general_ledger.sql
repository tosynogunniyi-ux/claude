-- The general ledger.
--
-- Until now Profitna kept a single-entry cash book: `transactions` rows with
-- a type and a category, and every report derived from them. That is honest
-- and it is what a lot of Nigerian small businesses actually need, but it
-- cannot express a receivable, cannot carry output VAT separately from
-- revenue, and cannot produce a balance sheet. Accrual invoicing needs all
-- three.
--
-- So this adds a real double-entry ledger alongside the cash book rather than
-- in place of it. Nothing already in `transactions` is moved, rewritten or
-- deleted, and every existing report keeps reading exactly what it read
-- before. The ledger is back-posted from those rows, so the two agree, and
-- from then on both are written together.
--
-- Three things the database guarantees rather than the code:
--   every entry balances (a deferred constraint trigger),
--   a line is a debit or a credit and never both,
--   a document cannot be posted twice (a unique source key).

-- ---------------------------------------------------------- chart of accounts

CREATE TABLE IF NOT EXISTS accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- What kind of asset or liability, for the balance sheet's own subtotals.
  subtype              TEXT,
  -- A system account is one the posting rules name directly — Accounts
  -- Receivable, Output VAT. It cannot be renamed away or archived, because
  -- something would then post to nothing.
  is_system            BOOLEAN NOT NULL DEFAULT false,
  archived_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(organization_id, type, code);

-- The existing category lists are what people actually choose from on screen.
-- Rather than a second list to keep in step, each one now points at the
-- account it posts to.
ALTER TABLE income_categories  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
-- Each bank account gets its own ledger account, so a trial balance can be
-- reconciled against a statement one account at a time.
ALTER TABLE bank_accounts      ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Nothing may post on or before this date. Closing a period is how a business
-- stops last year's figures moving under it after the accounts are filed.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS books_locked_through DATE;
-- Accrual by default, which is the decision this release implements. Cash
-- remains available for reporting because for many small businesses it is
-- what the tax return is built on.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS accounting_basis TEXT NOT NULL DEFAULT 'accrual'
  CHECK (accounting_basis IN ('accrual', 'cash'));

-- -------------------------------------------------------------- the journal

CREATE TABLE IF NOT EXISTS journal_entries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_date           DATE NOT NULL,
  memo                 TEXT,
  -- An immutable reference back to what caused this: 'invoice', 'payment',
  -- 'transaction', 'manual'. The row it names may be edited or deleted; the
  -- entry stays, because what was posted was posted.
  source_type          TEXT NOT NULL DEFAULT 'manual',
  source_id            UUID,
  -- Idempotency. 'invoice:<id>:issue' posts once however many times the
  -- issuing code runs — a retried request, a replayed webhook, a backfill run
  -- twice. This is the single most important column here: duplicate revenue
  -- is the failure mode of every accounting integration.
  source_key           TEXT,
  reversal_of          UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_source_key
  ON journal_entries(organization_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_org_date ON journal_entries(organization_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_source ON journal_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id             UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id           UUID NOT NULL REFERENCES accounts(id),
  line_no              INTEGER NOT NULL DEFAULT 0,
  debit_kobo           BIGINT NOT NULL DEFAULT 0 CHECK (debit_kobo >= 0),
  credit_kobo          BIGINT NOT NULL DEFAULT 0 CHECK (credit_kobo >= 0),
  description          TEXT,
  -- Who the line is about, where that is knowable: the customer on a
  -- receivable, the supplier on a payable. Lets a ledger be read per party
  -- without joining back through the document.
  party                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One or the other. A line carrying both is an arithmetic trick that hides
  -- what actually happened.
  CHECK (debit_kobo = 0 OR credit_kobo = 0),
  CHECK (debit_kobo > 0 OR credit_kobo > 0)
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id, line_no);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(organization_id, account_id);

-- Debits equal credits, checked by the database at commit rather than by
-- whichever code path happened to write the entry. DEFERRABLE because the
-- lines of one entry are inserted one at a time and an entry is only
-- lopsided in the middle of being written.
CREATE OR REPLACE FUNCTION journal_entry_balances() RETURNS trigger AS $$
DECLARE
  target UUID;
  d BIGINT;
  c BIGINT;
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit_kobo), 0), COALESCE(SUM(credit_kobo), 0)
    INTO d, c FROM journal_lines WHERE entry_id = target;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits %, credits %', target, d, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_balance ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_lines_balance
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balances();

-- ------------------------------------------------- accounts for every tenant
--
-- Seeded here for organisations that already exist; src/accounting/accounts.js
-- does the same for new ones. Both read from the same list, so there is one
-- definition of what a Profitna chart of accounts is.

INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
SELECT o.id, a.code, a.name, a.type, a.subtype, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('1000', 'Cash on Hand',             'asset',     'cash'),
    ('1010', 'Bank',                     'asset',     'cash'),
    ('1100', 'Accounts Receivable',      'asset',     'receivable'),
    ('1200', 'Inventory',                'asset',     'inventory'),
    ('1300', 'Payment Gateway Clearing', 'asset',     'clearing'),
    ('1400', 'Input VAT Receivable',     'asset',     'tax'),
    ('1410', 'Withholding Tax Receivable', 'asset',   'tax'),
    ('1500', 'Fixed Assets',             'asset',     'fixed'),
    ('2000', 'Accounts Payable',         'liability', 'payable'),
    ('2100', 'Output VAT Payable',       'liability', 'tax'),
    ('2300', 'Customer Deposits',        'liability', 'deposit'),
    ('3000', 'Owner Capital',            'equity',    'capital'),
    ('3100', 'Retained Earnings',        'equity',    'retained'),
    ('3900', 'Opening Balance Equity',   'equity',    'opening'),
    ('4900', 'Other Income',             'income',    'other'),
    ('5900', 'Gateway Processing Fees',  'expense',   'finance'),
    ('5950', 'Uncategorised Expense',    'expense',   'other')
  ) AS a(code, name, type, subtype)
ON CONFLICT (organization_id, code) DO NOTHING;

-- One account per income category, numbered in the order they are shown.
INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
SELECT c.organization_id,
       '4' || LPAD((100 + ROW_NUMBER() OVER (PARTITION BY c.organization_id ORDER BY c.sort_order, c.name))::text, 3, '0'),
       c.name, 'income', 'operating', false
  FROM income_categories c
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
SELECT c.organization_id,
       '5' || LPAD((100 + ROW_NUMBER() OVER (PARTITION BY c.organization_id ORDER BY c.sort_order, c.name))::text, 3, '0'),
       c.name, 'expense', 'operating', false
  FROM expense_categories c
ON CONFLICT (organization_id, code) DO NOTHING;

-- Point each category at its account.
UPDATE income_categories c SET account_id = a.id
  FROM accounts a
 WHERE a.organization_id = c.organization_id AND a.name = c.name AND a.type = 'income'
   AND c.account_id IS NULL;

UPDATE expense_categories c SET account_id = a.id
  FROM accounts a
 WHERE a.organization_id = c.organization_id AND a.name = c.name AND a.type = 'expense'
   AND c.account_id IS NULL;

-- And each bank account at one of its own, so a statement can be reconciled
-- against a single ledger account.
INSERT INTO accounts (organization_id, code, name, type, subtype, is_system)
SELECT b.organization_id,
       '10' || LPAD((20 + ROW_NUMBER() OVER (PARTITION BY b.organization_id ORDER BY b.sort_order, b.created_at))::text, 2, '0'),
       b.name, 'asset', 'cash', false
  FROM bank_accounts b
 WHERE b.archived_at IS NULL
ON CONFLICT (organization_id, code) DO NOTHING;

UPDATE bank_accounts b SET account_id = a.id
  FROM accounts a
 WHERE a.organization_id = b.organization_id AND a.name = b.name AND a.subtype = 'cash'
   AND a.code <> '1000' AND a.code <> '1010'
   AND b.account_id IS NULL;
