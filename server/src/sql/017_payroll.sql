-- Payroll.
--
-- The shape follows the one the rest of this product already uses: every
-- table scoped to an organisation, money in integer kobo, dates as DATE, and
-- anything that can be derived derived rather than stored.
--
-- Three decisions worth stating, because each is the kind that is expensive
-- to reverse later.
--
-- ONE. A pay run line is a snapshot, not a view.
--
-- Everywhere else in Profitna a document's status and balance are computed
-- from what it is made of, and a stored copy would be a second version of the
-- truth waiting to disagree. A payslip is the exception and must be. It is a
-- statement of what was calculated under the rules, the salary and the
-- declarations in force in that month — and all three change. Recomputing
-- March's payslip in December would quietly restate it. So every figure on
-- the line is written down when the run is calculated, and the rule set that
-- produced it is written down beside them.
--
-- TWO. Employee bank details and tax identifiers are ordinary columns.
--
-- They are not encrypted, and that is deliberate rather than an omission. A
-- Nigerian account number is given out to be paid into; a TIN and an RSA PIN
-- are identifiers, not credentials. Encrypting them while the salary they sit
-- next to — the genuinely sensitive figure — stays readable would be theatre,
-- and it would make the whole module depend on CREDENTIALS_KEY, which is not
-- set on every deployment. What actually protects this data is the same thing
-- that protects the books: tenancy on every query, a role check on every
-- route, and never writing it to a log. Payment gateway secrets stay
-- encrypted, because those are credentials and the distinction is the point.
--
-- THREE. Approval is one-way.
--
-- An approved run posts to the ledger and cannot be edited afterwards — only
-- reversed, which writes a mirror entry and leaves both visible. This is the
-- same rule the invoices follow and the reason the ledger can be trusted.

-- ------------------------------------------------------------- the people

CREATE TABLE IF NOT EXISTS employees (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The business's own number for them, if it has one. Unique per
  -- organisation when present, so an import cannot create the same person
  -- twice, but optional because plenty of small businesses have none.
  staff_number         TEXT,
  full_name            TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  department           TEXT,
  designation          TEXT,

  hire_date            DATE,
  -- Set when they leave. Status is derived from it and from `suspended_at`
  -- rather than stored, so the two cannot disagree.
  end_date             DATE,
  suspended_at         TIMESTAMPTZ,

  -- PAYE is remitted to the internal revenue service of the state where the
  -- employee resides, not where the employer is. Getting this wrong means
  -- remitting to the wrong government, which is not a clerical matter.
  state_of_residence   TEXT,
  tin                  TEXT,

  -- Where the salary goes.
  bank_name            TEXT,
  bank_account_name    TEXT,
  bank_account_number  TEXT,

  -- Pension. Exempt covers the genuine cases: an employer below the Pension
  -- Reform Act threshold, a contract worker, somebody over retirement age.
  pension_exempt       BOOLEAN NOT NULL DEFAULT false,
  rsa_pin              TEXT,
  pfa_name             TEXT,
  -- An employer may pay more than the 10% minimum. Basis points; null means
  -- the statutory rate.
  employer_pension_bp  INTEGER CHECK (employer_pension_bp IS NULL OR employer_pension_bp BETWEEN 0 AND 10000),

  nhf_exempt           BOOLEAN NOT NULL DEFAULT false,

  -- Rent relief replaced the Consolidated Relief Allowance in 2026. It is a
  -- relief claimed against rent actually paid, so it is nil until the
  -- employee declares a figure — never a default, and never assumed.
  annual_rent_kobo     BIGINT NOT NULL DEFAULT 0 CHECK (annual_rent_kobo >= 0),
  rent_declared_at     TIMESTAMPTZ,

  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employees_org ON employees(organization_id, full_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_staff_number
  ON employees(organization_id, lower(staff_number))
  WHERE staff_number IS NOT NULL AND staff_number <> '';

DROP TRIGGER IF EXISTS trg_employees_updated_at ON employees;
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------- what they earn

-- How a gross figure divides into components. 50 / 30 / 20 is offered because
-- it is what most Nigerian businesses use, and because the pension base is
-- basic plus housing plus transport — so the split is not cosmetic, it
-- changes what is contributed and what is taxed.
CREATE TABLE IF NOT EXISTS salary_structures (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  basic_bp             INTEGER NOT NULL CHECK (basic_bp BETWEEN 0 AND 10000),
  housing_bp           INTEGER NOT NULL CHECK (housing_bp BETWEEN 0 AND 10000),
  transport_bp         INTEGER NOT NULL CHECK (transport_bp BETWEEN 0 AND 10000),
  is_default           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The three parts are the whole of the gross. A structure that does not add
  -- up would silently move money out of the pension base.
  CHECK (basic_bp + housing_bp + transport_bp = 10000)
);
CREATE INDEX IF NOT EXISTS idx_salary_structures_org ON salary_structures(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_structure_default
  ON salary_structures(organization_id) WHERE is_default;

-- A salary, from a date. History rather than a column, so that a raise in
-- July does not retrospectively change June's payslip and so that "what were
-- they on in March" has an answer.
CREATE TABLE IF NOT EXISTS employee_salaries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from       DATE NOT NULL,
  gross_monthly_kobo   BIGINT NOT NULL CHECK (gross_monthly_kobo >= 0),
  structure_id         UUID REFERENCES salary_structures(id) ON DELETE SET NULL,

  -- Set only when a business states the components itself instead of taking
  -- the split. Null means "derive from the structure".
  basic_kobo           BIGINT CHECK (basic_kobo IS NULL OR basic_kobo >= 0),
  housing_kobo         BIGINT CHECK (housing_kobo IS NULL OR housing_kobo >= 0),
  transport_kobo       BIGINT CHECK (transport_kobo IS NULL OR transport_kobo >= 0),
  other_allowances_kobo BIGINT NOT NULL DEFAULT 0 CHECK (other_allowances_kobo >= 0),

  reason               TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_employee_salaries_lookup
  ON employee_salaries(employee_id, effective_from DESC);

-- ------------------------------------------------------------- the payroll

CREATE TABLE IF NOT EXISTS pay_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  period_year          INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2200),
  period_month         INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  -- The first of the month. Decides which tax rules apply, and what date the
  -- journal carries.
  period_date          DATE NOT NULL,
  pay_date             DATE,

  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'approved', 'paid', 'reversed')),

  -- Which law this run was calculated under. Written down because the answer
  -- changes and a payslip must stay explicable.
  rule_set             TEXT NOT NULL,

  approved_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ,
  reversed_at          TIMESTAMPTZ,
  reversal_reason      TEXT,

  journal_entry_id     UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

  note                 TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One payroll per month. The guarantee, not a check in code: two requests
-- arriving together both see no run, and only this index decides.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_run_once
  ON pay_runs(organization_id, period_year, period_month)
  WHERE status <> 'reversed';

CREATE INDEX IF NOT EXISTS idx_pay_runs_org ON pay_runs(organization_id, period_date DESC);

DROP TRIGGER IF EXISTS trg_pay_runs_updated_at ON pay_runs;
CREATE TRIGGER trg_pay_runs_updated_at BEFORE UPDATE ON pay_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One employee's month, in full. Every figure the payslip shows, frozen.
CREATE TABLE IF NOT EXISTS pay_run_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pay_run_id           UUID NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

  -- Copied, not joined. An employee who leaves and is deleted must not erase
  -- the payslip that says what they were paid, and a bank detail corrected in
  -- August must not change what July's schedule said.
  employee_name        TEXT NOT NULL,
  staff_number         TEXT,
  designation          TEXT,
  department           TEXT,
  bank_name            TEXT,
  bank_account_name    TEXT,
  bank_account_number  TEXT,

  basic_kobo           BIGINT NOT NULL DEFAULT 0,
  housing_kobo         BIGINT NOT NULL DEFAULT 0,
  transport_kobo       BIGINT NOT NULL DEFAULT 0,
  other_allowances_kobo BIGINT NOT NULL DEFAULT 0,
  bonus_kobo           BIGINT NOT NULL DEFAULT 0,
  commission_kobo      BIGINT NOT NULL DEFAULT 0,
  overtime_kobo        BIGINT NOT NULL DEFAULT 0,
  other_irregular_kobo BIGINT NOT NULL DEFAULT 0,
  gross_kobo           BIGINT NOT NULL DEFAULT 0,

  employee_pension_kobo BIGINT NOT NULL DEFAULT 0,
  nhf_kobo             BIGINT NOT NULL DEFAULT 0,
  paye_kobo            BIGINT NOT NULL DEFAULT 0,
  other_deductions_kobo BIGINT NOT NULL DEFAULT 0,
  total_deductions_kobo BIGINT NOT NULL DEFAULT 0,

  -- The employer's side. Never subtracted from anything the employee is paid.
  employer_pension_kobo BIGINT NOT NULL DEFAULT 0,

  net_kobo             BIGINT NOT NULL DEFAULT 0,

  -- The tax working, kept so that "why is my PAYE that" can be answered from
  -- the record rather than by recalculating under today's rules.
  tax_detail           JSONB,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An employee appears once in a run.
  UNIQUE (pay_run_id, employee_id),

  -- The arithmetic, enforced by the database rather than trusted from the
  -- application. A line that does not add up is a line that will be argued
  -- about with a staff member, and no code path should be able to write one.
  CHECK (gross_kobo = basic_kobo + housing_kobo + transport_kobo + other_allowances_kobo
                    + bonus_kobo + commission_kobo + overtime_kobo + other_irregular_kobo),
  CHECK (total_deductions_kobo = employee_pension_kobo + nhf_kobo + paye_kobo + other_deductions_kobo),
  CHECK (net_kobo = gross_kobo - total_deductions_kobo)
);
CREATE INDEX IF NOT EXISTS idx_pay_run_lines_run ON pay_run_lines(pay_run_id);
CREATE INDEX IF NOT EXISTS idx_pay_run_lines_employee ON pay_run_lines(employee_id, created_at DESC);

-- --------------------------------------------------------- what was paid

-- Salaries actually sent, and statutory money actually remitted. Separate
-- from the run, because approving a payroll and paying it are different
-- events that happen on different days and sometimes only partly.
CREATE TABLE IF NOT EXISTS payroll_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pay_run_id           UUID NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,

  kind                 TEXT NOT NULL CHECK (kind IN ('salaries', 'paye', 'pension', 'nhf', 'other')),
  amount_kobo          BIGINT NOT NULL CHECK (amount_kobo > 0),
  paid_on              DATE NOT NULL,
  bank_account_id      UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  reference            TEXT,
  note                 TEXT,

  journal_entry_id     UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_run ON payroll_payments(pay_run_id, kind);

-- ------------------------------------------------------------- the settings

-- What is genuinely the business's own choice. Tax rates are not here, and
-- that is the point: a business that could edit its own bands could edit them
-- retrospectively.
CREATE TABLE IF NOT EXISTS payroll_settings (
  organization_id      UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  pension_applies      BOOLEAN NOT NULL DEFAULT true,
  nhf_applies          BOOLEAN NOT NULL DEFAULT true,
  -- Employer-only, and off until a business says they apply to it. Neither
  -- ever touches an employee's net pay.
  nsitf_applies        BOOLEAN NOT NULL DEFAULT false,
  itf_applies          BOOLEAN NOT NULL DEFAULT false,
  default_pay_day      INTEGER CHECK (default_pay_day IS NULL OR default_pay_day BETWEEN 1 AND 31),
  payslip_note         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_payroll_settings_updated_at ON payroll_settings;
CREATE TRIGGER trg_payroll_settings_updated_at BEFORE UPDATE ON payroll_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------- the ledger's own entries

-- `journal_entries.source_type` is constrained to a known list — migration
-- 012 added it — so a payroll entry is rejected by the database until
-- 'payroll' is on it. Extended rather than replaced with something broader:
-- the list is there to stop a typo inventing a source nobody reports on, and
-- that is worth keeping.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('manual', 'invoice', 'bill', 'payment', 'transaction',
                         'opening', 'adjustment', 'stock', 'credit_note', 'receipt',
                         'payroll'));
