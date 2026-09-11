-- ============================================================
-- 014 CRM SUPER-ADMIN CROSS-SHOP READ (Slice 1)
--
-- ADDITIVE ONLY. CRM is being re-architected as a Super-Admin-primary
-- module. Super Admin needs to read leads/opportunities/tasks/activity
-- across every shop (dashboard rollups, cross-shop list views) without
-- weakening tenant isolation for anyone else.
--
-- Follows the exact precedent migration 009 already set for `crm_outbox`
-- (the cross-tenant worker drain): a SECOND, ADDITIONAL permissive RLS
-- policy, scoped to a dedicated GUC, that Postgres OR's together with the
-- existing tenant policy. Nothing here touches or replaces the existing
-- `<table>_tenant_isolation` policies (still `FOR ALL`, still the only way
-- to INSERT/UPDATE/DELETE) -- this migration only ever ADDS read visibility,
-- and only for SELECT.
--
-- The GUC is `app.crm_admin_ctx = 'on'`, set exclusively by
-- src/utils/db.ts::withSuperAdminCrmTx() (added alongside this migration),
-- which is only ever called from routes gated by requireSuperAdminPg. A
-- tenant request never sets this GUC, so tenant isolation is unaffected.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY, safe to re-run.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS crm_lead_superadmin_read ON crm_lead;
CREATE POLICY crm_lead_superadmin_read ON crm_lead
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

DROP POLICY IF EXISTS crm_opportunity_superadmin_read ON crm_opportunity;
CREATE POLICY crm_opportunity_superadmin_read ON crm_opportunity
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

DROP POLICY IF EXISTS crm_task_superadmin_read ON crm_task;
CREATE POLICY crm_task_superadmin_read ON crm_task
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

DROP POLICY IF EXISTS crm_activity_superadmin_read ON crm_activity;
CREATE POLICY crm_activity_superadmin_read ON crm_activity
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

COMMIT;
