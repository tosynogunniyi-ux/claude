-- Why does an account see Profitna as read-only?
--
-- Read-only: this script changes nothing. Run it, copy the whole output.
--
--   psql "$DATABASE_URL" -f diagnose-role.sql
--
-- Set the email you sign in with. Nothing else needs editing.
\set email 'tosyn.ogunniyi@gmail.com'

\echo ''
\echo '=== 1. The account itself ============================================'
-- If status is not 'active' every request is refused, whatever the role says.
SELECT u.id,
       u.email,
       u.full_name,
       u.auth_provider,
       u.status,
       u.last_login_at
  FROM users u
 WHERE lower(u.email) = lower(:'email');

\echo ''
\echo '=== 2. Every set of books this account belongs to ====================='
-- "picked" marks the one the app opens: it takes the oldest membership when
-- the session carries no preference. If picked is not the row you expect,
-- that is the whole answer.
SELECT o.name                                   AS organisation,
       m.role,
       m.created_at                             AS joined,
       row_number() OVER (ORDER BY m.created_at) = 1 AS picked,
       o.id                                     AS org_id
  FROM memberships m
  JOIN users u         ON u.id = m.user_id
  JOIN organizations o ON o.id = m.organization_id
 WHERE lower(u.email) = lower(:'email')
 ORDER BY m.created_at;

\echo ''
\echo '=== 3. Is the subscription locking the books? ========================='
-- A locked account is read-only no matter what the role is: the trial or the
-- paid term has run out. daysLeft below zero means expired. Each row carries
-- its own trial length; the 14 is only the fallback for rows that predate it.
SELECT o.name                                              AS organisation,
       s.status,
       s.seats,
       s.cycle,
       s.trial_start,
       COALESCE(s.current_period_end, s.trial_start + COALESCE(s.trial_days, 14))  AS access_until,
       COALESCE(s.current_period_end, s.trial_start + COALESCE(s.trial_days, 14))
         - CURRENT_DATE                                    AS days_left,
       (COALESCE(s.current_period_end, s.trial_start + COALESCE(s.trial_days, 14)) < CURRENT_DATE)
                                                           AS locked_out
  FROM subscriptions s
  JOIN organizations o ON o.id = s.organization_id
 WHERE o.id IN (SELECT m.organization_id
                  FROM memberships m JOIN users u ON u.id = m.user_id
                 WHERE lower(u.email) = lower(:'email'));

\echo ''
\echo '=== 4. Everyone on those books ========================================'
-- An organisation must keep at least one admin. If this shows none, that is
-- the fault and section 5 fixes it.
SELECT o.name AS organisation, u2.email, m2.role, m2.created_at AS joined
  FROM memberships m2
  JOIN users u2        ON u2.id = m2.user_id
  JOIN organizations o ON o.id = m2.organization_id
 WHERE o.id IN (SELECT m.organization_id
                  FROM memberships m JOIN users u ON u.id = m.user_id
                 WHERE lower(u.email) = lower(:'email'))
 ORDER BY o.name, m2.created_at;

\echo ''
\echo '=== 5. Which migrations have been applied ============================='
-- 005 is the newest. If the list stops short, the deploy did not migrate and
-- that is a different problem from the role.
SELECT name, applied_at FROM schema_migrations ORDER BY name;

\echo ''
\echo '=== end. Copy everything above. ======================================='
