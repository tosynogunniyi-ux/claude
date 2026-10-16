-- The trial length, remembered per subscription.
--
-- Until now it was a single constant and the end of a trial was derived from
-- it, which meant changing the number moved every trial that was already
-- running. That was wanted once — lengthening 14 days to 30 reached everybody
-- mid-trial, which is a gift. Shortening it the same way is the opposite: an
-- account twenty days into a thirty-day trial would be locked out tonight,
-- having been told all week it had ten days left.
--
-- So the length is now a fact about the subscription, fixed when it is
-- created. Changing the default changes what new sign-ups get and nothing
-- else.
--
-- Existing rows are backfilled with 30, because 30 is what they have been
-- shown since that change and what they are owed. Rows that have already been
-- paid for carry a real current_period_end and never consult this.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_days INTEGER;

UPDATE subscriptions SET trial_days = 30 WHERE trial_days IS NULL;

-- Left nullable on purpose. Every read uses COALESCE against the current
-- default, so a row inserted by something that has not learned about this
-- column yet still behaves, rather than failing at the moment somebody signs
-- up.
COMMENT ON COLUMN subscriptions.trial_days IS
  'Days of free trial this subscription was created with. NULL falls back to the current default in src/pricing.js.';
