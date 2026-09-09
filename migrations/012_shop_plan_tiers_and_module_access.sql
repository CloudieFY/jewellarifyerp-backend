-- ============================================================
-- 012 SHOP PLAN TIERS + MODULE / PAGE ACCESS CONTROL
--
-- The superadmin dashboard (frontend, already deployed) and the Mongo
-- `routes/superAdmin.ts` were updated to:
--   * offer the new plan tiers  spark / hero / prime / custom
--   * carry per-shop `allowedModules` / `allowedPages` access lists
-- The PostgreSQL control plane (routes/superAdminPg.ts) was never updated, so
-- creating or renewing a shop with a new plan failed the old
-- `shops_plan_check` ("violates check constraint shops_plan_check") and the
-- access lists had nowhere to be stored.
--
-- This migration brings the PG `shops` table in line with the Mongo model:
--   1. widen `shops_plan_check` to the 8 values the frontend
--      `SubscriptionPlanType` union allows (new 4 + legacy 4, so existing
--      rows keep validating)
--   2. add `allowed_modules` / `allowed_pages` text[] columns (default '{}')
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD, ADD COLUMN IF NOT EXISTS.
-- ============================================================

BEGIN;

-- 1. plan tiers ------------------------------------------------
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_plan_check;
ALTER TABLE shops
  ADD CONSTRAINT shops_plan_check
  CHECK (plan IN (
    'spark', 'hero', 'prime', 'custom',        -- current tiers
    'trial', 'basic', 'standard', 'premium'    -- legacy (existing rows)
  ));

-- 2. per-shop module / page access lists ---------------------
ALTER TABLE shops ADD COLUMN IF NOT EXISTS allowed_modules text[] NOT NULL DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS allowed_pages   text[] NOT NULL DEFAULT '{}';

COMMIT;
