-- Asking a customer to pay, and knowing which answer belongs to which ask.
--
-- A gateway payment has two references and conflating them is the usual bug.
-- The one we generate before sending the customer anywhere is ours; the one
-- the gateway reports afterwards is theirs. Only ours can be used to look up
-- what the payment was supposed to be for, and only theirs is unique across
-- the gateway's whole estate. Both are stored, and they are different columns.

CREATE TABLE IF NOT EXISTS payment_links (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id           UUID REFERENCES invoices(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('paystack', 'monnify')),
  -- Ours. Generated here, sent to the gateway, and the only thing the public
  -- return page is given — so it carries 96 bits of randomness rather than
  -- the invoice number, which would let anybody walk a business's invoices.
  reference            TEXT NOT NULL,
  amount_kobo          BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency             TEXT NOT NULL DEFAULT 'NGN',
  email                TEXT,
  customer_name        TEXT,
  -- The gateway's hosted checkout. Stored so a link can be resent without
  -- opening a second transaction at the gateway, which is what made the
  -- subscription flow fail the first time it went live.
  checkout_url         TEXT,
  -- Theirs, once there is one.
  provider_reference   TEXT,
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'paid', 'failed', 'cancelled', 'expired')),
  customer_payment_id  UUID REFERENCES customer_payments(id) ON DELETE SET NULL,
  last_checked_at      TIMESTAMPTZ,
  last_error           TEXT,
  expires_at           TIMESTAMPTZ,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);
-- Globally unique as well as per tenant: the return page and the webhook are
-- given a reference and nothing else, so it has to identify one row in the
-- whole table or they would have to be told which tenant to look in — and
-- being told that by the caller is how cross-tenant lookups happen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_reference ON payment_links(reference);
CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON payment_links(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_open
  ON payment_links(organization_id, created_at DESC) WHERE status = 'open';

-- ------------------------------------------------ what the settings screen shows

-- Enough to tell a wrong paste from a right one, and no more: the last four
-- characters and the readable prefix. Written at save time, because the
-- ciphertext cannot be read without the key and the screen should still be
-- able to say which key is in there.
ALTER TABLE merchant_accounts ADD COLUMN IF NOT EXISTS secret_hint TEXT;
-- A one-way digest of the secret, so two environments can be compared
-- ("this is the same key you already had") without either holding the other's.
ALTER TABLE merchant_accounts ADD COLUMN IF NOT EXISTS secret_fingerprint TEXT;
-- Which mode the gateway itself said the credentials were in when they were
-- last proved. A dashboard toggle says what should be true; this says what
-- was, and the two disagreeing is worth a warning on screen.
ALTER TABLE merchant_accounts ADD COLUMN IF NOT EXISTS verified_mode TEXT;
