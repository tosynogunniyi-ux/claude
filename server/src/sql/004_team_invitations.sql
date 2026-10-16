-- =========================================================================
-- Profitna — team invitations
--
-- memberships has carried a role since the first migration, and requireOrg()
-- has enforced it, but there was no way to create a second membership: an
-- organisation could only ever have the person who signed up. This is that
-- missing half.
--
-- There is no email delivery in this product — and no pretending there is.
-- An invitation produces a link the subscriber copies and sends however they
-- already talk to their accountant. Only the SHA-256 of the token is stored,
-- so the table is not a set of usable keys to other people's books; the raw
-- token is shown once, and a new one can be issued, which cancels the old.
-- =========================================================================

CREATE TABLE invitations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                TEXT NOT NULL,
  full_name            TEXT,
  role                 TEXT NOT NULL DEFAULT 'viewer'
                         CHECK (role IN ('admin', 'accountant', 'viewer')),
  token_hash           TEXT NOT NULL UNIQUE,
  invited_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days',
  accepted_at          TIMESTAMPTZ,
  accepted_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at           TIMESTAMPTZ
);

CREATE INDEX idx_invitations_org ON invitations(organization_id, created_at DESC);

-- One live invitation per address per organisation. Re-inviting somebody who
-- is already pending should reissue their link, not queue a second seat.
CREATE UNIQUE INDEX idx_invitations_pending
  ON invitations (organization_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
