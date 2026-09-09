-- ============================================================
-- 011 CRM OPPORTUNITIES / PIPELINE + TASKS (Phase 2)
--
-- ADDITIVE ONLY. New tables: crm_opportunity, crm_task. The EXISTING
-- crm_activity timeline (migration 010) is extended to cover the two new
-- entity types plus the Phase 2 activity verbs — no data is moved or dropped.
--
-- Tenant safety (identical model to migrations 009/010):
--   * every new table has shop_id NOT NULL REFERENCES shops(id) ON DELETE CASCADE
--   * crm_opportunity / crm_task get RLS (ENABLE + FORCE) with the same
--     `app.shop_id` policy — a query without tenant context sees no rows and
--     cannot insert (fails CLOSED)
--   * cross-shop FK values (assigned_to, branch_id, lead_id, customer_id,
--     related_id) are additionally blocked at write time by the application,
--     whose lookups run under RLS and therefore cannot see another shop's rows
--
-- `customers` stays NOT under RLS (legacy ERP reads it on the bare pool); the
-- opportunity/task routes scope it with an explicit WHERE shop_id = $1.
--
-- Idempotent: IF NOT EXISTS / DROP-IF-EXISTS-then-CREATE throughout.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. crm_opportunity  (the sales pipeline)
--    stage is a FIXED enum (mirrors crm_lead.status) — 'won' / 'lost' are the
--    two terminal stages and are only ever set through the /win and /lose
--    endpoints, which also stamp won_at / lost_at.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_opportunity (
    id                  text PRIMARY KEY,
    shop_id             text NOT NULL REFERENCES shops(id)   ON DELETE CASCADE,
    branch_id           text REFERENCES branches(id)         ON DELETE SET NULL,
    assigned_to         text REFERENCES users(id)            ON DELETE SET NULL,
    created_by          text REFERENCES users(id)            ON DELETE SET NULL,

    -- optional origin / association (both nullable, both shop-checked by the app)
    lead_id             text REFERENCES crm_lead(id)         ON DELETE SET NULL,
    customer_id         text REFERENCES customers(id)        ON DELETE SET NULL,

    title               varchar(255) NOT NULL,
    stage               varchar(20) NOT NULL DEFAULT 'prospecting'
                        CHECK (stage IN ('prospecting','qualification','proposal','negotiation','won','lost')),
    amount              numeric(14,2),
    probability         integer CHECK (probability IS NULL OR (probability BETWEEN 0 AND 100)),
    source              varchar(40),
    notes               text,
    expected_close_date date,

    won_at              timestamptz,
    lost_at             timestamptz,
    lost_reason         text,
    last_activity_at    timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_opp_shop            ON crm_opportunity(shop_id);
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_stage      ON crm_opportunity(shop_id, stage)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_branch     ON crm_opportunity(shop_id, branch_id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_assigned   ON crm_opportunity(shop_id, assigned_to)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_customer   ON crm_opportunity(shop_id, customer_id)   WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_lead       ON crm_opportunity(shop_id, lead_id)       WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_created    ON crm_opportunity(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_opp_shop_close      ON crm_opportunity(shop_id, expected_close_date) WHERE deleted_at IS NULL;

ALTER TABLE crm_opportunity ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_opportunity FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_opportunity_tenant_isolation ON crm_opportunity;
CREATE POLICY crm_opportunity_tenant_isolation ON crm_opportunity
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- 2. crm_task  (assignable to-dos, optionally linked to a lead / opportunity
--    / customer). Completing a task appends an activity row to the linked
--    entity's timeline (handled in the application layer).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_task (
    id               text PRIMARY KEY,
    shop_id          text NOT NULL REFERENCES shops(id)  ON DELETE CASCADE,
    branch_id        text REFERENCES branches(id)        ON DELETE SET NULL,
    assigned_to      text REFERENCES users(id)           ON DELETE SET NULL,
    created_by       text REFERENCES users(id)           ON DELETE SET NULL,
    completed_by     text REFERENCES users(id)           ON DELETE SET NULL,

    title            varchar(255) NOT NULL,
    description      text,
    status           varchar(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','completed','cancelled')),
    priority         varchar(10) NOT NULL DEFAULT 'medium'
                     CHECK (priority IN ('low','medium','high','urgent')),
    due_at           timestamptz,

    related_type     varchar(24) CHECK (related_type IS NULL OR related_type IN ('lead','opportunity','customer')),
    related_id       text,

    completed_at     timestamptz,
    last_activity_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,

    -- related_type and related_id are set together or not at all
    CONSTRAINT crm_task_related_pair CHECK ((related_type IS NULL) = (related_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_crm_task_shop            ON crm_task(shop_id);
CREATE INDEX IF NOT EXISTS idx_crm_task_shop_status     ON crm_task(shop_id, status)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_task_shop_assigned   ON crm_task(shop_id, assigned_to)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_task_shop_branch     ON crm_task(shop_id, branch_id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_task_shop_due        ON crm_task(shop_id, due_at)        WHERE deleted_at IS NULL AND status NOT IN ('completed','cancelled');
CREATE INDEX IF NOT EXISTS idx_crm_task_related         ON crm_task(shop_id, related_type, related_id) WHERE related_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_task_shop_created    ON crm_task(shop_id, created_at DESC);

ALTER TABLE crm_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_task FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_task_tenant_isolation ON crm_task;
CREATE POLICY crm_task_tenant_isolation ON crm_task
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- 3. crm_activity: widen the polymorphic timeline for Phase 2.
--    Migration 010 created it for ('lead','customer') only. We now also allow
--    'opportunity' and 'task', and add the Phase 2 verbs. The column CHECK
--    constraints keep their auto-generated names.
-- ------------------------------------------------------------
ALTER TABLE crm_activity DROP CONSTRAINT IF EXISTS crm_activity_entity_type_check;
ALTER TABLE crm_activity
  ADD CONSTRAINT crm_activity_entity_type_check
  CHECK (entity_type IN ('lead','customer','opportunity','task'));

ALTER TABLE crm_activity DROP CONSTRAINT IF EXISTS crm_activity_type_check;
ALTER TABLE crm_activity
  ADD CONSTRAINT crm_activity_type_check
  CHECK (type IN ('note','status_change','assignment','qualification','conversion',
                  'call','email','meeting','system','stage_change','won','lost','completion'));

COMMIT;
