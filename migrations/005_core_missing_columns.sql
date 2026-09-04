-- ============================================================
-- 005 CORE MISSING COLUMNS
-- Adds fields the frontend/Mongo models use that were not in the
-- initial PostgreSQL schema, for the core-first route migration
-- (suppliers, supplier_transactions, invoices).
-- Idempotent: safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- suppliers
-- ------------------------------------------------------------
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ac_no                        text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS group_name                   text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone                        text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pan                          text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS location                     text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city                         text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS state                        text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pin                          text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country                      text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS occupation                   text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ref_by                       text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website                      text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS dob                          text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS anniversary                  text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_no                       text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tcs                          numeric;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tds                          numeric;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS uid_no                       text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cst_no                       text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_gold         numeric;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_gold_type    text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_silver       numeric;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_silver_type  text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_amount       numeric;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_amount_type  text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_date         text;

-- ------------------------------------------------------------
-- supplier_transactions
-- ------------------------------------------------------------
ALTER TABLE supplier_transactions ADD COLUMN IF NOT EXISTS gold_weight    numeric;
ALTER TABLE supplier_transactions ADD COLUMN IF NOT EXISTS silver_weight  numeric;
ALTER TABLE supplier_transactions ADD COLUMN IF NOT EXISTS ref_no         text;
ALTER TABLE supplier_transactions ADD COLUMN IF NOT EXISTS rate_per_gram  numeric;

-- ------------------------------------------------------------
-- invoices
-- ------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_no            text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS old_exchange_type  text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS old_gold_details   jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS old_silver_details jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_paid            boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_returned        boolean NOT NULL DEFAULT false;

-- Per-shop uniqueness of the invoice number (the Mongo schema had a global
-- unique index on `number`; under one shared DB it must be scoped by shop).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_shop_number_uq
  ON invoices (shop_id, number);

COMMIT;
