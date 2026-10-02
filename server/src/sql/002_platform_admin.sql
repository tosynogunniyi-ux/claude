-- =========================================================================
-- Profitna — platform administration
--
-- Everything the owner's Control Center needs, and nothing a tenant can
-- reach. Three separate concerns:
--
--   1. Platform identity      platform_admins, platform_admin_sessions,
--                             platform_audit_log — deliberately NOT the
--                             users/memberships tables. A tenant's `admin`
--                             role is admin *of one set of books*; it must
--                             never be able to grow into platform access,
--                             so the two live in different tables with
--                             different credentials, sessions and cookies.
--
--   2. Account lifecycle      users.status, so an account can be suspended
--                             or deactivated, and last_login_at, so the
--                             console can show activity.
--
--   3. Billing history        payments, and the period dates a renewal or
--                             expiry is read from.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. PLATFORM IDENTITY
-- -------------------------------------------------------------------------

CREATE TABLE platform_admins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT,
  -- Base32, issued when the account is created. Second factor is mandatory:
  -- a single stolen password must not be enough to read every customer's
  -- books. Null only on accounts created before enrolment was possible.
  totp_secret          TEXT,
  totp_enrolled_at     TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  last_login_ip        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_platform_admins_updated_at BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Server-side sessions rather than a self-contained token: the owner can end
-- a session from another device, and a stolen cookie stops working the moment
-- the row is revoked. Only the SHA-256 of the token is stored, so the table
-- itself is not a set of usable credentials.
CREATE TABLE platform_admin_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id             UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL UNIQUE,
  ip                   TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ
);
CREATE INDEX idx_platform_sessions_admin ON platform_admin_sessions(admin_id, created_at DESC);

-- Separate from audit_log, which is scoped to one organisation. Platform
-- actions cross tenants, so they have nowhere to go in that table — and
-- keeping them apart means a tenant export can never leak them.
CREATE TABLE platform_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id             UUID REFERENCES platform_admins(id) ON DELETE SET NULL,
  -- Snapshotted, so the record still reads correctly if the admin is removed.
  admin_email          TEXT,
  action               TEXT NOT NULL,
  target_type          TEXT,
  target_id            UUID,
  detail               JSONB,
  ip                   TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_created ON platform_audit_log(created_at DESC);
CREATE INDEX idx_platform_audit_target ON platform_audit_log(target_type, target_id);

-- -------------------------------------------------------------------------
-- 2. ACCOUNT LIFECYCLE
-- -------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN status           TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended', 'deactivated')),
  ADD COLUMN status_reason    TEXT,
  ADD COLUMN status_changed_at TIMESTAMPTZ,
  ADD COLUMN last_login_at    TIMESTAMPTZ,
  ADD COLUMN last_login_ip    TEXT,
  ADD COLUMN login_count      INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_users_created ON users(created_at DESC);
CREATE INDEX idx_users_status ON users(status);

-- -------------------------------------------------------------------------
-- 3. BILLING HISTORY
-- -------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN current_period_start DATE,
  ADD COLUMN current_period_end   DATE,
  ADD COLUMN suspended_at         TIMESTAMPTZ;

-- 'suspended' joins the stored statuses because it is an act, not a
-- consequence. 'expired' deliberately does not: it is derived from the period
-- end at read time, the same rule invoices follow — a stored expiry drifts out
-- of sync with the date the moment nothing runs to update it.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'suspended'));

CREATE TABLE payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'paystack',
  provider_reference   TEXT,
  purpose              TEXT NOT NULL DEFAULT 'subscription'
                         CHECK (purpose IN ('card_authorisation', 'subscription', 'renewal')),
  amount               NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'NGN',
  status               TEXT NOT NULL DEFAULT 'success'
                         CHECK (status IN ('success', 'failed', 'pending', 'refunded')),
  channel              TEXT,
  card_brand           TEXT,
  card_last4           TEXT,
  paid_at              TIMESTAMPTZ,
  detail               JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A webhook and a verify call can describe the same transaction; the
  -- reference makes the second one a no-op rather than a duplicate charge
  -- in the history.
  UNIQUE (provider, provider_reference)
);
CREATE INDEX idx_payments_org ON payments(organization_id, created_at DESC);
CREATE INDEX idx_payments_created ON payments(created_at DESC);
