-- Automatic email.
--
-- Profitna has never sent an email. That was deliberate and stated throughout
-- the product — invitations produce a link to copy, and nothing claimed to
-- send mail — so this is the first time an address is used for anything. It
-- is worth being careful in proportion.
--
-- Three tables, and the division between them is the point:
--
--   What a person has agreed to receive (email_preferences) is about the
--   person, not the organisation. Somebody who is admin of two businesses
--   made one decision about marketing, not two.
--
--   What may never be sent to an address again (email_suppressions) is about
--   the address, not the person. A hard bounce, a spam complaint or a
--   complete opt-out belongs to the mailbox and survives the account being
--   deleted and recreated.
--
--   What was decided and what happened (email_messages) is the record. Every
--   message is written down before it is sent, including the ones that were
--   never sent and why — because "we have no record of that" is the worst
--   answer to give somebody asking what you emailed them.

-- ------------------------------------------------------- what a person agreed to
--
-- Three categories, and they are not interchangeable:
--
--   transactional — the trial ending, a payment failing, the account's
--     status. Sent because there is a contract and the person needs to know
--     something about their own account. No consent is required for these
--     under the NDPR and none is implied; they also cannot be switched off,
--     because switching them off means not being told your card failed.
--
--   onboarding — help using the thing they signed up for. Defaulted on,
--     because somebody who just created an account wants to be shown how to
--     use it, and off with one click.
--
--   marketing — anything that is really about selling. Defaulted OFF and
--     requires an explicit act to turn on. Nothing in the journey this
--     release builds is marketing; the category exists so that nothing can
--     later be smuggled in under "onboarding".

CREATE TABLE IF NOT EXISTS email_preferences (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Recorded rather than assumed, so the row says what was true. It is not
  -- offered as a switch anywhere, and the sender treats false as "this
  -- person's account communications are broken", not as consent withdrawn.
  transactional           BOOLEAN NOT NULL DEFAULT true,
  onboarding              BOOLEAN NOT NULL DEFAULT true,
  marketing               BOOLEAN NOT NULL DEFAULT false,
  -- When and how consent was given, because "they ticked a box" is not a
  -- record and an unanswerable complaint is an expensive one.
  marketing_consent_at    TIMESTAMPTZ,
  marketing_consent_source TEXT,
  -- Everything off, from a one-click unsubscribe. Kept separate from the
  -- three flags so the reason is visible: all-off by choice is not the same
  -- as three defaults that happen to be false.
  all_off                 BOOLEAN NOT NULL DEFAULT false,
  all_off_at              TIMESTAMPTZ,
  -- Identifies the person in an unsubscribe link without a session and
  -- without guessing: 256 bits, unique, and rotatable on its own.
  unsubscribe_token       TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unsub_token ON email_preferences(unsubscribe_token);

-- ------------------------------------------------- what must never be sent again
--
-- By address, deliberately. A mailbox that hard-bounced or reported spam
-- stays suppressed whether or not the account behind it still exists, and
-- deleting and recreating an account does not clear it. Sending to a known
-- bad address is how a sending domain's reputation is destroyed, and
-- reputation is shared across every customer on it.

CREATE TABLE IF NOT EXISTS email_suppressions (
  address      TEXT PRIMARY KEY,
  reason       TEXT NOT NULL CHECK (reason IN ('bounced', 'complained', 'unsubscribed', 'manual', 'invalid')),
  detail       TEXT,
  -- A soft bounce clears; a hard one does not. Null means permanent.
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------- every message, decided
--
-- A row is written when the journey decides a message is due — before any
-- attempt to send it. So the outbox holds the ones that were sent, the ones
-- that failed, the ones that were held because the address is suppressed, and
-- the ones that were rendered while sending was switched off. Nothing is
-- decided and then forgotten.

CREATE TABLE IF NOT EXISTS email_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The address as it was when the message was decided. A person who changes
  -- their email does not retrospectively change where last month's trial
  -- reminder went.
  to_address         TEXT NOT NULL,
  to_name            TEXT,

  kind               TEXT NOT NULL,
  category           TEXT NOT NULL CHECK (category IN ('transactional', 'onboarding', 'marketing')),

  -- The whole of idempotency. One message per (organisation, kind, key), and
  -- the key carries whatever makes an occurrence distinct — the trial end
  -- date, the charge attempt number — so a second trial gets a second
  -- reminder and a retried pass does not.
  dedupe_key         TEXT NOT NULL,

  subject            TEXT NOT NULL,
  body_text          TEXT NOT NULL,
  body_html          TEXT,

  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'sent', 'failed', 'suppressed', 'held', 'cancelled')),
  -- Why it is in that state, in a sentence. 'held' with "sending is switched
  -- off" is a different thing from 'suppressed' with "this address bounced",
  -- and a screen that cannot tell them apart is no use.
  reason             TEXT,

  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_attempt_at    TIMESTAMPTZ,
  -- Backoff, and the quiet-hours window. A message is not looked at before
  -- this time.
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  sent_at            TIMESTAMPTZ,
  provider           TEXT,
  provider_message_id TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The guarantee that nobody is told twice that their trial is ending.
--
-- Checked in code with a row lock as well, but the index is what makes it
-- true: two containers running the pass at the same moment, a retried
-- request, a restore replaying a partial log. Duplicate email is the
-- characteristic failure of a lifecycle system and the only reliable defence
-- is a unique index, not a check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_once
  ON email_messages(organization_id, kind, dedupe_key, user_id);

CREATE INDEX IF NOT EXISTS idx_email_pending
  ON email_messages(next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_email_org ON email_messages(organization_id, created_at DESC);

-- ------------------------------------------------------- what the provider said
--
-- Delivered, bounced, complained. Written by the provider's webhook; the
-- bounce and complaint rows are what feed email_suppressions, which is the
-- only way a suppression list stays accurate without somebody watching a
-- mailbox.

CREATE TABLE IF NOT EXISTS email_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID REFERENCES email_messages(id) ON DELETE CASCADE,
  address      TEXT,
  event        TEXT NOT NULL,
  detail       TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_message ON email_events(message_id, occurred_at);
