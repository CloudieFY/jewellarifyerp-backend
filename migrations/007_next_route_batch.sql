-- ============================================================
-- 007 NEXT ROUTE BATCH
-- Schema changes needed to port the remaining thin CRUD routes to Postgres:
--   sales, expenses, advances, schemes, gold-rates, employees, orders,
--   repairs, girvi, purchases, sales-returns.
--
--   1. `purchase_items` child table — the Mongo `purchases` doc embedded an
--      `items[]` array (purchaseItemSchema) that the initial PG schema dropped.
--      The frontend purchases screen relies on line items, so recreate it as a
--      child table (mirrors sale_items / girvi_items).
--   2. Relax two CHECK constraints that are stricter than what the Mongo app
--      enforced (same rationale as migration 006). Both Mongo schema fields
--      were plain String with only a default — no enum — so faithfully
--      migrated data / real payloads can carry other values.
--
-- Idempotent: safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- purchase_items  (child of purchases)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    purchase_id UUID NOT NULL
        REFERENCES purchases(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL DEFAULT 'Jewellery Item',
    category VARCHAR(100) DEFAULT 'Gold',
    metal VARCHAR(50) DEFAULT 'Gold',
    purity VARCHAR(50) DEFAULT '22K',
    huid VARCHAR(100),
    barcode VARCHAR(150),
    pcs NUMERIC(15,3) DEFAULT 1,

    gross_weight NUMERIC(15,3) DEFAULT 0,
    less_weight NUMERIC(15,3) DEFAULT 0,
    net_weight NUMERIC(15,3) DEFAULT 0,
    hmc NUMERIC(15,3) DEFAULT 0,

    rate_per_gram NUMERIC(15,2) DEFAULT 0,
    making_charge_type VARCHAR(20) DEFAULT 'fixed'
        CHECK (making_charge_type IS NULL
               OR making_charge_type IN ('per_gram','percentage','fixed')),
    making_charge NUMERIC(15,2) DEFAULT 0,
    making_charge_pct NUMERIC(15,3) DEFAULT 0,
    total NUMERIC(15,2) DEFAULT 0,

    hsn_code VARCHAR(50),
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
    ON purchase_items(purchase_id);

-- ------------------------------------------------------------
-- repairs.metal: Mongo schema was `{ type: String, default: 'Gold' }`
-- with no enum. Drop the enum CHECK.
-- ------------------------------------------------------------
ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_metal_check;

-- ------------------------------------------------------------
-- orders.rate_lock_status: Mongo schema was
-- `{ type: String, default: 'Locked' }` with no enum. Drop the enum CHECK.
-- ------------------------------------------------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_rate_lock_status_check;

COMMIT;
