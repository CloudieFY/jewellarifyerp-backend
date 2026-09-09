-- ============================================================
-- 010 CRM LEAD + ACTIVITY TIMELINE + CUSTOMER CRM FIELDS (Phase 1)
--
-- ADDITIVE ONLY. New tables: crm_lead, crm_activity. New NULLABLE /
-- defaulted columns on the EXISTING `customers` table so the CRM can treat
-- it as the customer master (it is NOT a second customer store).
--
-- Tenant safety (same model as migration 009):
--   * crm_lead / crm_activity get RLS (ENABLE + FORCE) with the
--     `app.shop_id` policy — a query with no tenant context sees no rows
--     and cannot insert (fails CLOSED)
--   * `customers` stays NOT under RLS (legacy ERP reads it on the bare
--     pool); CRM routes scope it with an explicit WHERE shop_id = $1
--
-- crm_activity is a polymorphic timeline. Phase 1 only writes 'lead' and
-- 'customer' rows; migration 011 widens the CHECKs for opportunities/tasks.
--
-- Idempotent: IF NOT EXISTS / DROP-IF-EXISTS-then-CREATE throughout.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. customers: CRM master fields
--    `notes` already exists (migration 001). Everything else is added here.
-- ------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email        varchar(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status       varchar(20) NOT NULL DEFAULT 'active';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source       varchar(40);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_to  text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS segment_id   text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS dob          date;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS anniversary  date;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id    text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at   timestamptz;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_status_check
  CHECK (status IN ('active','inactive','prospect'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_assigned_to_fkey;
ALTER TABLE customers
  ADD CONSTRAINT customers_assigned_to_fkey
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_branch_id_fkey;
ALTER TABLE customers
  ADD CONSTRAINT customers_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_shop_active
    ON customers(shop_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_shop_assigned
    ON customers(shop_id, assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_shop_branch
    ON customers(shop_id, branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_shop_status
    ON customers(shop_id, status);

-- ------------------------------------------------------------
-- 2. crm_lead
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_lead (
    id                    text PRIMARY KEY,
    shop_id               text NOT NULL REFERENCES shops(id)     ON DELETE CASCADE,
    branch_id             text REFERENCES branches(id)           ON DELETE SET NULL,
    assigned_to           text REFERENCES users(id)              ON DELETE SET NULL,
    created_by            text REFERENCES users(id)              ON DELETE SET NULL,

    name                  varchar(255) NOT NULL,
    phone                 varchar(50),
    email                 varchar(255),
    company               varchar(255),
    source                varchar(40),
    status                varchar(20) NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','contacted','qualified','unqualified','converted','lost')),
    notes                 text,

    -- association / conversion
    customer_id           text REFERENCES customers(id)          ON DELETE SET NULL,
    converted_customer_id text REFERENCES customers(id)          ON DELETE SET NULL,
    qualified_at          timestamptz,
    converted_at          timestamptz,
    last_activity_at      timestamptz,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    deleted_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_shop            ON crm_lead(shop_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_status     ON crm_lead(shop_id, status)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_branch     ON crm_lead(shop_id, branch_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_assigned   ON crm_lead(shop_id, assigned_to)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_created    ON crm_lead(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_phone      ON crm_lead(shop_id, phone)        WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lead_converted_cust  ON crm_lead(shop_id, converted_customer_id) WHERE converted_customer_id IS NOT NULL;

ALTER TABLE crm_lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_lead_tenant_isolation ON crm_lead;
CREATE POLICY crm_lead_tenant_isolation ON crm_lead
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- 3. crm_activity  (polymorphic timeline)
--    Phase 1 verbs only; migration 011 adds stage_change / won / lost /
--    completion and the 'opportunity' / 'task' entity types.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_activity (
    id            text PRIMARY KEY,
    shop_id       text NOT NULL REFERENCES shops(id)  ON DELETE CASCADE,
    branch_id     text REFERENCES branches(id)        ON DELETE SET NULL,
    entity_type   varchar(24) NOT NULL
                  CHECK (entity_type IN ('lead','customer')),
    entity_id     text NOT NULL,
    type          varchar(24) NOT NULL
                  CHECK (type IN ('note','status_change','assignment','qualification',
                                  'conversion','call','email','meeting','system')),
    body          text,
    data          jsonb,
    actor_user_id text REFERENCES users(id)           ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activity_shop_created
    ON crm_activity(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_timeline
    ON crm_activity(shop_id, entity_type, entity_id, created_at DESC);

ALTER TABLE crm_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activity FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_activity_tenant_isolation ON crm_activity;
CREATE POLICY crm_activity_tenant_isolation ON crm_activity
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

COMMIT;
