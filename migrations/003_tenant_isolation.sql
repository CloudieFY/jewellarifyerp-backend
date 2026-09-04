BEGIN;

-- ============================================================
-- 003 TENANT ISOLATION
-- PostgreSQL single-database multi-tenant architecture
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add shop_id to tenant/business parent tables
-- ------------------------------------------------------------

ALTER TABLE advances
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE counters
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE expenses
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE girvi
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE gold_rates
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE inventory
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE invoices
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE opening_stock
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE orders
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE purchases
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE repairs
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE sales
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE sales_returns
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE schemes
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE stock_adjustments
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE stock_ledger
  ADD COLUMN shop_id text NOT NULL;

ALTER TABLE stock_transfers
  ADD COLUMN shop_id text NOT NULL;


-- ------------------------------------------------------------
-- 2. Foreign keys -> shops
-- ------------------------------------------------------------

ALTER TABLE advances
  ADD CONSTRAINT advances_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE counters
  ADD CONSTRAINT counters_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE girvi
  ADD CONSTRAINT girvi_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE gold_rates
  ADD CONSTRAINT gold_rates_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE inventory
  ADD CONSTRAINT inventory_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE opening_stock
  ADD CONSTRAINT opening_stock_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE orders
  ADD CONSTRAINT orders_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE purchases
  ADD CONSTRAINT purchases_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE repairs
  ADD CONSTRAINT repairs_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE sales
  ADD CONSTRAINT sales_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE sales_returns
  ADD CONSTRAINT sales_returns_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE schemes
  ADD CONSTRAINT schemes_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE stock_ledger
  ADD CONSTRAINT stock_ledger_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;

ALTER TABLE stock_transfers
  ADD CONSTRAINT stock_transfers_shop_fk
  FOREIGN KEY (shop_id)
  REFERENCES shops(id)
  ON DELETE CASCADE;


-- ------------------------------------------------------------
-- 3. Tenant indexes
-- ------------------------------------------------------------

CREATE INDEX idx_advances_shop
  ON advances(shop_id);

CREATE INDEX idx_counters_shop
  ON counters(shop_id);

CREATE INDEX idx_expenses_shop
  ON expenses(shop_id);

CREATE INDEX idx_girvi_shop
  ON girvi(shop_id);

CREATE INDEX idx_gold_rates_shop
  ON gold_rates(shop_id);

CREATE INDEX idx_inventory_shop
  ON inventory(shop_id);

CREATE INDEX idx_invoices_shop
  ON invoices(shop_id);

CREATE INDEX idx_opening_stock_shop
  ON opening_stock(shop_id);

CREATE INDEX idx_orders_shop
  ON orders(shop_id);

CREATE INDEX idx_purchases_shop
  ON purchases(shop_id);

CREATE INDEX idx_repairs_shop
  ON repairs(shop_id);

CREATE INDEX idx_sales_shop
  ON sales(shop_id);

CREATE INDEX idx_sales_returns_shop
  ON sales_returns(shop_id);

CREATE INDEX idx_schemes_shop
  ON schemes(shop_id);

CREATE INDEX idx_stock_adjustments_shop
  ON stock_adjustments(shop_id);

CREATE INDEX idx_stock_ledger_shop
  ON stock_ledger(shop_id);

CREATE INDEX idx_stock_transfers_shop
  ON stock_transfers(shop_id);


-- ------------------------------------------------------------
-- 4. Tenant-safe document numbering
-- ------------------------------------------------------------

-- Invoice number should be unique per shop, not globally.
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_number_key;

CREATE UNIQUE INDEX invoices_shop_number_key
  ON invoices(shop_id, number);


-- Sales return number should be unique per shop.
ALTER TABLE sales_returns
  DROP CONSTRAINT IF EXISTS sales_returns_return_no_key;

CREATE UNIQUE INDEX sales_returns_shop_return_no_key
  ON sales_returns(shop_id, return_no);


-- Order number should be unique per shop.
CREATE UNIQUE INDEX orders_shop_order_no_key
  ON orders(shop_id, order_no);


-- ------------------------------------------------------------
-- 5. Existing tenant tables:
-- already contain shop_id.
-- Add indexes where useful.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_brands_shop
  ON brands(shop_id);

CREATE INDEX IF NOT EXISTS idx_categories_shop
  ON categories(shop_id);

CREATE INDEX IF NOT EXISTS idx_collection_masters_shop
  ON collection_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_diamond_masters_shop
  ON diamond_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_hsn_masters_shop
  ON hsn_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_karigars_shop
  ON karigars(shop_id);

CREATE INDEX IF NOT EXISTS idx_metal_masters_shop
  ON metal_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_purity_masters_shop
  ON purity_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_stone_masters_shop
  ON stone_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_subcategories_shop
  ON subcategories(shop_id);

CREATE INDEX IF NOT EXISTS idx_suppliers_shop
  ON suppliers(shop_id);

CREATE INDEX IF NOT EXISTS idx_unit_masters_shop
  ON unit_masters(shop_id);

CREATE INDEX IF NOT EXISTS idx_users_shop
  ON users(shop_id);

CREATE INDEX IF NOT EXISTS idx_employees_shop
  ON employees(shop_id);


-- ------------------------------------------------------------
-- 6. Child-table indexes
-- Child tables inherit tenant scope through their parent.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_girvi_items_girvi
  ON girvi_items(girvi_id);

CREATE INDEX IF NOT EXISTS idx_inventory_stones_inventory
  ON inventory_stones(inventory_id);

CREATE INDEX IF NOT EXISTS idx_inventory_diamonds_inventory
  ON inventory_diamonds(inventory_id);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON invoice_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON invoice_payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale
  ON sale_items(sale_id);

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return
  ON sales_return_items(sales_return_id);


-- ------------------------------------------------------------
-- 7. Composite indexes for common tenant queries
-- ------------------------------------------------------------

CREATE INDEX idx_inventory_shop_status
  ON inventory(shop_id, status);

CREATE INDEX idx_inventory_shop_category
  ON inventory(shop_id, category);

CREATE INDEX idx_inventory_shop_barcode
  ON inventory(shop_id, barcode);

CREATE INDEX idx_invoices_shop_created_at
  ON invoices(shop_id, created_at DESC);

CREATE INDEX idx_sales_shop_created_at
  ON sales(shop_id, created_at DESC);

CREATE INDEX idx_purchases_shop_date
  ON purchases(shop_id, date DESC);

CREATE INDEX idx_expenses_shop_date
  ON expenses(shop_id, date DESC);

CREATE INDEX idx_orders_shop_status
  ON orders(shop_id, status);

CREATE INDEX idx_repairs_shop_status
  ON repairs(shop_id, status);

CREATE INDEX idx_girvi_shop_status
  ON girvi(shop_id, status);

CREATE INDEX idx_sales_returns_shop_customer
  ON sales_returns(shop_id, customer_id);

CREATE INDEX idx_schemes_shop_status
  ON schemes(shop_id, status);


-- ============================================================
-- DONE
-- ============================================================

COMMIT;
