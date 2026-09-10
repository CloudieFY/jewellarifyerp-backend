-- ============================================================
-- 013 CRM LEAD QUALIFICATION (Phase 3)
--
-- ADDITIVE ONLY. No new tables. New NULLABLE columns on the EXISTING
-- `crm_lead` table so a lead can carry a structured qualification result
-- (qualified / nurture / disqualified) alongside — never replacing — the
-- Phase 1 `crm_lead.status` model.
--
-- What this migration deliberately does NOT touch:
--   * `crm_lead_status_check` — the existing status enum
--     (new/contacted/qualified/unqualified/converted/lost) is unchanged.
--     The `nurture` outcome lives ONLY in the new `qualification_status`
--     column; the row's `status` is left alone for that outcome.
--   * RLS — `crm_lead` and `crm_activity` keep their migration-010 policies
--     (ENABLE + FORCE, `app.shop_id`). No policy is added, dropped or altered.
--   * `crm_opportunity` — lead -> opportunity promotion (Phase 3 backend)
--     reuses the existing table and its `lead_id` column. No schema change.
--
-- The only change outside `crm_lead` is widening `crm_activity_type_check`
-- to allow the new `'promotion'` timeline verb (same DROP-then-ADD pattern
-- migration 011 used for the Phase 2 verbs).
--
-- Legacy backfill (approved): rows that were already qualified/unqualified
-- under the Phase 1 flow get their new `qualification_status` populated so
-- the two models start consistent. It only writes rows where the new column
-- is still NULL and the lead is live — it never overwrites data.
--
-- Idempotent: IF NOT EXISTS / DROP-IF-EXISTS-then-ADD throughout; the
-- backfill is NULL-guarded so a re-run is a no-op.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. crm_lead: structured qualification columns
--    All NULLABLE. NULL `qualification_status` == "not yet assessed".
-- ------------------------------------------------------------
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS qualification_status  varchar(16);
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS qualification_score   smallint;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS qualification_notes   text;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS qualification_data    jsonb;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS qualified_by          text;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS disqualified_at       timestamptz;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS disqualified_reason   text;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS nurture_until         date;

ALTER TABLE crm_lead DROP CONSTRAINT IF EXISTS crm_lead_qualification_status_check;
ALTER TABLE crm_lead
  ADD CONSTRAINT crm_lead_qualification_status_check
  CHECK (qualification_status IS NULL
         OR qualification_status IN ('qualified','nurture','disqualified'));

ALTER TABLE crm_lead DROP CONSTRAINT IF EXISTS crm_lead_qualification_score_check;
ALTER TABLE crm_lead
  ADD CONSTRAINT crm_lead_qualification_score_check
  CHECK (qualification_score IS NULL OR (qualification_score BETWEEN 0 AND 100));

ALTER TABLE crm_lead DROP CONSTRAINT IF EXISTS crm_lead_qualified_by_fkey;
ALTER TABLE crm_lead
  ADD CONSTRAINT crm_lead_qualified_by_fkey
  FOREIGN KEY (qualified_by) REFERENCES users(id) ON DELETE SET NULL;

-- Filter the qualification pipeline the same way `idx_crm_lead_shop_status`
-- serves the Phase 1 status filter: always shop-scoped, live rows only.
CREATE INDEX IF NOT EXISTS idx_crm_lead_shop_qual_status
    ON crm_lead(shop_id, qualification_status)
    WHERE deleted_at IS NULL AND qualification_status IS NOT NULL;

-- ------------------------------------------------------------
-- 2. crm_activity: allow the Phase 3 'promotion' verb.
--    Migrations 010/011 built this list; we only append. The column CHECK
--    keeps its auto-generated name.
-- ------------------------------------------------------------
ALTER TABLE crm_activity DROP CONSTRAINT IF EXISTS crm_activity_type_check;
ALTER TABLE crm_activity
  ADD CONSTRAINT crm_activity_type_check
  CHECK (type IN ('note','status_change','assignment','qualification','conversion',
                  'call','email','meeting','system','stage_change','won','lost',
                  'completion','promotion'));

-- ------------------------------------------------------------
-- 3. Legacy backfill (approved). Only populates the new column where it is
--    still NULL on a live lead — never overwrites, safe to re-run.
-- ------------------------------------------------------------
UPDATE crm_lead
   SET qualification_status = 'qualified',
       qualified_at         = COALESCE(qualified_at, updated_at)
 WHERE status = 'qualified'
   AND qualification_status IS NULL
   AND deleted_at IS NULL;

UPDATE crm_lead
   SET qualification_status = 'disqualified',
       disqualified_at      = COALESCE(disqualified_at, updated_at)
 WHERE status = 'unqualified'
   AND qualification_status IS NULL
   AND deleted_at IS NULL;

COMMIT;
