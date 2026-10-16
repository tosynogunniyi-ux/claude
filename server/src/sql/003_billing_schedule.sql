-- =========================================================================
-- Profitna — automatic billing
--
-- chargeDue() has existed since the subscription work; nothing called it, so
-- a trial that ended simply stayed on 'trialing' for ever. This adds the two
-- things a scheduler needs: somewhere to record what it tried on each
-- subscription, so a declined card is retried on a schedule rather than on
-- every tick, and somewhere to record each run, so the owner can see whether
-- billing is actually happening.
-- =========================================================================

ALTER TABLE subscriptions
  ADD COLUMN charge_attempts         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_charge_attempt_at  TIMESTAMPTZ,
  ADD COLUMN next_charge_attempt_at  TIMESTAMPTZ,
  ADD COLUMN last_charge_error       TEXT;

-- The scheduler's shortlist: a term that has run out, on a subscription that
-- is still meant to be billed. Partial, because most rows never match.
CREATE INDEX idx_subscriptions_billable
  ON subscriptions (current_period_end, trial_start)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE billing_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  trigger              TEXT NOT NULL DEFAULT 'schedule'
                         CHECK (trigger IN ('schedule', 'manual')),
  considered           INTEGER NOT NULL DEFAULT 0,
  charged              INTEGER NOT NULL DEFAULT 0,
  failed               INTEGER NOT NULL DEFAULT 0,
  amount               NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Set when the run itself broke, as opposed to an individual card being
  -- declined. An empty error with charged = failed = 0 means "nothing was due",
  -- which is the normal state most days.
  error                TEXT
);
CREATE INDEX idx_billing_runs_started ON billing_runs(started_at DESC);
