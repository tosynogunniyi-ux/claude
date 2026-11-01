-- One name, one account.
--
-- Migration 009 seeded a system account called "Other Income" (4900) and then
-- created one account per income category — and the default category list
-- also contains "Other Income". So an organisation ended up with two accounts
-- of the same name and type, a P&L that listed it twice, and a lookup by name
-- that could land on either depending on row order.
--
-- Nothing had gone wrong in the ledger: both accounts balanced and the trial
-- balance was correct. It was a reporting fault, which is the kind that gets
-- believed.
--
-- This moves every line from the duplicate onto the system account, repoints
-- the category, and removes the empty one. Running it twice does nothing the
-- second time.

WITH dupes AS (
  SELECT dup.id AS duplicate_id, keep.id AS keep_id, dup.organization_id
    FROM accounts dup
    JOIN accounts keep
      ON keep.organization_id = dup.organization_id
     AND lower(keep.name) = lower(dup.name)
     AND keep.type = dup.type
     AND keep.is_system = true
   WHERE dup.is_system = false
)
UPDATE journal_lines l SET account_id = d.keep_id
  FROM dupes d
 WHERE l.account_id = d.duplicate_id;

WITH dupes AS (
  SELECT dup.id AS duplicate_id, keep.id AS keep_id
    FROM accounts dup
    JOIN accounts keep
      ON keep.organization_id = dup.organization_id
     AND lower(keep.name) = lower(dup.name)
     AND keep.type = dup.type
     AND keep.is_system = true
   WHERE dup.is_system = false
)
UPDATE income_categories c SET account_id = d.keep_id
  FROM dupes d WHERE c.account_id = d.duplicate_id;

WITH dupes AS (
  SELECT dup.id AS duplicate_id, keep.id AS keep_id
    FROM accounts dup
    JOIN accounts keep
      ON keep.organization_id = dup.organization_id
     AND lower(keep.name) = lower(dup.name)
     AND keep.type = dup.type
     AND keep.is_system = true
   WHERE dup.is_system = false
)
UPDATE expense_categories c SET account_id = d.keep_id
  FROM dupes d WHERE c.account_id = d.duplicate_id;

DELETE FROM accounts dup
 USING accounts keep
 WHERE keep.organization_id = dup.organization_id
   AND lower(keep.name) = lower(dup.name)
   AND keep.type = dup.type
   AND keep.is_system = true
   AND dup.is_system = false
   AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = dup.id);

-- Stop it happening again. A name is unique per organisation and type, so the
-- lookup that posting rules do by name has exactly one answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_unique_name
  ON accounts(organization_id, type, lower(name));
