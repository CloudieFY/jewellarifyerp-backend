-- ============================================================
-- 015 CRM DEMO MANAGEMENT (Slice 4)
--
-- ADDITIVE ONLY. New table crm_demo. Follows the exact tenant-safety model
-- as every prior CRM table (009/010/011): shop_id NOT NULL REFERENCES
-- shops(id) ON DELETE CASCADE, every other FK ON DELETE SET NULL, RLS
-- ENABLE+FORCE with the app.shop_id tenant policy, PLUS the migration-014
-- precedent of an additive SELECT-only policy for Super Admin cross-shop
-- reads (app.crm_admin_ctx).
--
-- Relationship design (approved): a demo carries BOTH lead_id and
-- opportunity_id as independent nullable FKs (not a single polymorphic
-- related_type/related_id pair like crm_task) so that a demo scheduled
-- against a lead which later promotes to an opportunity keeps its original
-- lead lineage instead of losing it. At least one of the two must be set
-- (CHECK) -- a demo with no lead and no opportunity has nothing to be a
-- demo of. customer_id is independently nullable, for a demo scheduled
-- against an already-converted customer (e.g. a repeat/upsell demo).
--
-- `mode` and `outcome` are deliberately UNCONSTRAINED free text, not a
-- CHECK-enforced enum: no confirmed blueprint value list exists for them
-- (flagged in the Slice 4 plan) -- picking a wrong enum now would need a
-- follow-up migration to fix, so the app layer validates instead.
--
-- Idempotent: IF NOT EXISTS / DROP-IF-EXISTS-then-CREATE throughout.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS crm_demo (
    id             text PRIMARY KEY,
    shop_id        text NOT NULL REFERENCES shops(id)          ON DELETE CASCADE,
    branch_id      text REFERENCES branches(id)                ON DELETE SET NULL,
    lead_id        text REFERENCES crm_lead(id)                ON DELETE SET NULL,
    opportunity_id text REFERENCES crm_opportunity(id)         ON DELETE SET NULL,
    customer_id    text REFERENCES customers(id)                ON DELETE SET NULL,
    assigned_to    text REFERENCES users(id)                   ON DELETE SET NULL,
    created_by     text REFERENCES users(id)                   ON DELETE SET NULL,

    scheduled_at   timestamptz NOT NULL,
    status         varchar(20) NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','completed','cancelled','no_show')),
    mode           varchar(40),
    outcome        varchar(40),
    notes          text,
    next_action    text,
    completed_at   timestamptz,

    last_activity_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at     timestamptz,

    CONSTRAINT crm_demo_lead_or_opportunity CHECK (lead_id IS NOT NULL OR opportunity_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crm_demo_shop            ON crm_demo(shop_id);
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_status     ON crm_demo(shop_id, status)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_scheduled  ON crm_demo(shop_id, scheduled_at)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_assigned   ON crm_demo(shop_id, assigned_to)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_branch     ON crm_demo(shop_id, branch_id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_lead       ON crm_demo(shop_id, lead_id)       WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_opportunity ON crm_demo(shop_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_customer   ON crm_demo(shop_id, customer_id)   WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_demo_shop_created    ON crm_demo(shop_id, created_at DESC);

ALTER TABLE crm_demo ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_demo FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_demo_tenant_isolation ON crm_demo;
CREATE POLICY crm_demo_tenant_isolation ON crm_demo
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

DROP POLICY IF EXISTS crm_demo_superadmin_read ON crm_demo;
CREATE POLICY crm_demo_superadmin_read ON crm_demo
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

-- ------------------------------------------------------------
-- crm_activity: widen the polymorphic timeline to cover demos.
-- ------------------------------------------------------------
ALTER TABLE crm_activity DROP CONSTRAINT IF EXISTS crm_activity_entity_type_check;
ALTER TABLE crm_activity
  ADD CONSTRAINT crm_activity_entity_type_check
  CHECK (entity_type IN ('lead','customer','opportunity','task','demo'));

-- ------------------------------------------------------------
-- crm_task: widen related_type so a follow-up task can link to a demo,
-- reusing the exact related_type/related_id mechanism already used for
-- lead/opportunity/customer follow-ups (Slices 2-3) -- no new relationship
-- table needed.
-- ------------------------------------------------------------
ALTER TABLE crm_task DROP CONSTRAINT IF EXISTS crm_task_related_type_check;
ALTER TABLE crm_task
  ADD CONSTRAINT crm_task_related_type_check
  CHECK (related_type IS NULL OR related_type IN ('lead','opportunity','customer','demo'));

COMMIT;
