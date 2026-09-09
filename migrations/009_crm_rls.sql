-- ============================================================
-- 009 CRM ROW-LEVEL SECURITY (Phase 1)
--
-- Turns on FORCE row-level security for every CRM foundation table created
-- in migration 008. From here on the ONLY way to touch these tables is
-- inside a transaction that has set the tenant GUC:
--
--     SELECT set_config('app.shop_id', <shopId>, true);
--
-- which src/utils/db.ts::withTenant(shopId, cb) does for every CRM request.
-- A query with no tenant context sees zero rows and cannot insert — the
-- module fails CLOSED.
--
-- `crm_outbox` is the ONE cross-tenant consumer (a single worker drains
-- every shop's jobs), so its policy also accepts the worker GUC
-- `app.crm_worker = 'on'`, set by withWorkerTx(). No other table honours it.
--
-- `customers` is deliberately NOT brought under RLS here: the legacy ERP
-- routes read it on the bare pool. CRM code scopes it with an explicit
-- `WHERE shop_id = $1` instead.
--
-- Idempotent: ENABLE/FORCE are no-ops when already set; every policy is
-- DROP-then-CREATE.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- branches
-- ------------------------------------------------------------
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branches_tenant_isolation ON branches;
CREATE POLICY branches_tenant_isolation ON branches
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- user_branches
-- ------------------------------------------------------------
ALTER TABLE user_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_branches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_branches_tenant_isolation ON user_branches;
CREATE POLICY user_branches_tenant_isolation ON user_branches
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- crm_audit_log
-- ------------------------------------------------------------
ALTER TABLE crm_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_audit_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_audit_log_tenant_isolation ON crm_audit_log;
CREATE POLICY crm_audit_log_tenant_isolation ON crm_audit_log
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- crm_notification
-- ------------------------------------------------------------
ALTER TABLE crm_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_notification FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_notification_tenant_isolation ON crm_notification;
CREATE POLICY crm_notification_tenant_isolation ON crm_notification
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

-- ------------------------------------------------------------
-- crm_outbox  (tenant OR the cross-tenant worker)
-- ------------------------------------------------------------
ALTER TABLE crm_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_outbox FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_outbox_tenant_isolation ON crm_outbox;
CREATE POLICY crm_outbox_tenant_isolation ON crm_outbox
  USING      (shop_id = current_setting('app.shop_id', true)
              OR current_setting('app.crm_worker', true) = 'on')
  WITH CHECK (shop_id = current_setting('app.shop_id', true)
              OR current_setting('app.crm_worker', true) = 'on');

COMMIT;
