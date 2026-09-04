BEGIN;

-- ============================================================
-- GOLD RATES
-- ============================================================

CREATE TABLE IF NOT EXISTS gold_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gold24 NUMERIC(15,3) NOT NULL DEFAULT 0,
    gold22 NUMERIC(15,3) NOT NULL DEFAULT 0,
    gold20 NUMERIC(15,3) NOT NULL DEFAULT 0,
    gold18 NUMERIC(15,3) NOT NULL DEFAULT 0,
    silver NUMERIC(15,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gold_rates_created_at
    ON gold_rates(created_at DESC);


-- ============================================================
-- INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(255) NOT NULL,
    item_code VARCHAR(100),
    barcode VARCHAR(150),
    qr_code VARCHAR(150),
    sku VARCHAR(150),

    category VARCHAR(150) NOT NULL DEFAULT 'Gold',
    subcategory VARCHAR(150),
    brand VARCHAR(150),
    collection_name VARCHAR(150),
    product_type VARCHAR(150),
    design_no VARCHAR(150),
    model_no VARCHAR(150),
    note TEXT,

    metal_type VARCHAR(50) NOT NULL DEFAULT 'Gold',
    purity VARCHAR(50) NOT NULL DEFAULT '22K',
    huid VARCHAR(100),
    hallmark_certified BOOLEAN DEFAULT TRUE,
    metal_color VARCHAR(50) DEFAULT 'Yellow',
    gender VARCHAR(30) DEFAULT 'Unisex',

    gross_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    stone_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    diamond_weight NUMERIC(15,3) DEFAULT 0,
    other_weight NUMERIC(15,3) DEFAULT 0,
    net_weight NUMERIC(15,3) NOT NULL DEFAULT 0,

    purchase_rate NUMERIC(15,2) DEFAULT 0,
    metal_rate NUMERIC(15,2) DEFAULT 0,

    making_charge_type VARCHAR(30)
        CHECK (making_charge_type IN ('per_gram','percentage','fixed'))
        DEFAULT 'fixed',

    making_charge NUMERIC(15,2) NOT NULL DEFAULT 500,
    making_charge_pct NUMERIC(8,3) DEFAULT 0,
    wastage_pct NUMERIC(8,3) DEFAULT 0,

    stone_cost NUMERIC(15,2) DEFAULT 0,
    diamond_cost NUMERIC(15,2) DEFAULT 0,
    other_charges NUMERIC(15,2) DEFAULT 0,

    cost_price NUMERIC(15,2) DEFAULT 0,
    selling_price NUMERIC(15,2) DEFAULT 0,
    min_selling_price NUMERIC(15,2) DEFAULT 0,
    mrp NUMERIC(15,2) DEFAULT 0,
    rate_per_gram NUMERIC(15,2) DEFAULT 7200,

    hsn_code VARCHAR(30) DEFAULT '7113',
    gst_pct NUMERIC(8,3) NOT NULL DEFAULT 0,
    gst_type VARCHAR(20)
        CHECK (gst_type IN ('Inclusive','Exclusive'))
        DEFAULT 'Exclusive',

    stock NUMERIC(15,3) NOT NULL DEFAULT 1,
    available_stock NUMERIC(15,3) DEFAULT 1,
    reserved_stock NUMERIC(15,3) DEFAULT 0,
    min_stock NUMERIC(15,3) DEFAULT 0,
    max_stock NUMERIC(15,3) DEFAULT 100,
    reorder_level NUMERIC(15,3) DEFAULT 1,
    allow_negative_stock BOOLEAN DEFAULT FALSE,

    branch VARCHAR(150) DEFAULT 'Main Store',
    godown VARCHAR(150) DEFAULT 'Main Vault',
    rack VARCHAR(100),
    shelf VARCHAR(100),
    tray VARCHAR(100),
    locker VARCHAR(100),

    default_supplier_id VARCHAR(100),
    supplier_item_code VARCHAR(150),
    lead_time_days INTEGER DEFAULT 7,

    is_manufactured BOOLEAN DEFAULT FALSE,
    bom TEXT,
    labour_charge NUMERIC(15,2) DEFAULT 0,
    casting_charge NUMERIC(15,2) DEFAULT 0,
    polishing_charge NUMERIC(15,2) DEFAULT 0,
    setting_charge NUMERIC(15,2) DEFAULT 0,

    image_url TEXT,
    image_urls JSONB DEFAULT '[]'::jsonb,
    certificate_pdf TEXT,

    status VARCHAR(30)
        CHECK (status IN ('Active','Inactive','Discontinued'))
        DEFAULT 'Active',

    last_purchase_price NUMERIC(15,2) DEFAULT 0,
    last_selling_price NUMERIC(15,2) DEFAULT 0,

    created_by VARCHAR(100),
    updated_by VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_code
    ON inventory(item_code);

CREATE INDEX IF NOT EXISTS idx_inventory_barcode
    ON inventory(barcode);

CREATE INDEX IF NOT EXISTS idx_inventory_sku
    ON inventory(sku);

CREATE INDEX IF NOT EXISTS idx_inventory_category
    ON inventory(category);

CREATE INDEX IF NOT EXISTS idx_inventory_metal_purity
    ON inventory(metal_type, purity);

CREATE INDEX IF NOT EXISTS idx_inventory_status
    ON inventory(status);


-- ============================================================
-- INVENTORY STONES
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_stones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    inventory_id UUID NOT NULL
        REFERENCES inventory(id) ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,
    pcs NUMERIC(15,3) DEFAULT 1,
    weight NUMERIC(15,3) DEFAULT 0,
    rate NUMERIC(15,2) DEFAULT 0,
    amount NUMERIC(15,2) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inventory_stones_inventory
    ON inventory_stones(inventory_id);


-- ============================================================
-- INVENTORY DIAMONDS
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_diamonds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    inventory_id UUID NOT NULL
        REFERENCES inventory(id) ON DELETE CASCADE,

    shape VARCHAR(50) DEFAULT 'Round',
    color VARCHAR(20) DEFAULT 'G',
    clarity VARCHAR(30) DEFAULT 'VS1',
    weight NUMERIC(15,3) DEFAULT 0,
    pcs NUMERIC(15,3) DEFAULT 1,
    rate NUMERIC(15,2) DEFAULT 0,
    cert_no VARCHAR(150),
    amount NUMERIC(15,2) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inventory_diamonds_inventory
    ON inventory_diamonds(inventory_id);


-- ============================================================
-- SALES
-- ============================================================

CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id VARCHAR(100) NOT NULL,

    total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,

    status VARCHAR(20)
        CHECK (status IN ('pending','completed','cancelled'))
        DEFAULT 'pending',

    payment_status VARCHAR(20)
        CHECK (payment_status IN ('pending','paid','partial'))
        DEFAULT 'pending',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_customer
    ON sales(customer_id);

CREATE INDEX IF NOT EXISTS idx_sales_created_at
    ON sales(created_at DESC);


-- ============================================================
-- SALES ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    sale_id UUID NOT NULL
        REFERENCES sales(id) ON DELETE CASCADE,

    item_name VARCHAR(255) NOT NULL,
    quantity NUMERIC(15,3) NOT NULL DEFAULT 1,
    rate NUMERIC(15,2) NOT NULL DEFAULT 0,
    amount NUMERIC(15,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale
    ON sale_items(sale_id);


-- ============================================================
-- INVOICES
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    number VARCHAR(100) NOT NULL UNIQUE,

    type VARCHAR(20) NOT NULL
        CHECK (type IN ('GST','NON-GST')),

    customer_id VARCHAR(100),
    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),

    discount NUMERIC(15,2) NOT NULL DEFAULT 0,

    old_gold_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    old_silver_amount NUMERIC(15,2) DEFAULT 0,

    old_metal_type VARCHAR(20)
        CHECK (old_metal_type IN ('Gold','Silver','Mixed'))
        DEFAULT 'Gold',

    bill_metal VARCHAR(20)
        CHECK (bill_metal IN ('Gold','Silver'))
        DEFAULT 'Gold',

    payment_mode VARCHAR(20) NOT NULL
        CHECK (payment_mode IN ('Cash','UPI','Card','EMI')),

    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    gst_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    total NUMERIC(15,2) NOT NULL DEFAULT 0,

    amount_paid NUMERIC(15,2),
    balance_due NUMERIC(15,2),

    customer_address TEXT,
    customer_signature TEXT,
    authorized_signatory TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at
    ON invoices(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_customer
    ON invoices(customer_id);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_mobile
    ON invoices(customer_mobile);

CREATE INDEX IF NOT EXISTS idx_invoices_type
    ON invoices(type);


-- ============================================================
-- INVOICE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    invoice_id UUID NOT NULL
        REFERENCES invoices(id) ON DELETE CASCADE,

    product_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,

    purity VARCHAR(50),

    net_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    gross_weight NUMERIC(15,3),
    stone_weight NUMERIC(15,3),

    rate_per_gram NUMERIC(15,2) NOT NULL DEFAULT 0,

    making_charge NUMERIC(15,2) NOT NULL DEFAULT 0,
    making_charge_pct NUMERIC(8,3),

    making_charge_type VARCHAR(30)
        CHECK (
            making_charge_type IN
            ('PERCENTAGE','PER_GRAM','FIXED','PER_PIECE')
        ),

    making_charge_value NUMERIC(15,2),

    stone_charge NUMERIC(15,2) NOT NULL DEFAULT 0,

    gst_pct NUMERIC(8,3) NOT NULL DEFAULT 0,

    qty NUMERIC(15,3) NOT NULL DEFAULT 1,

    huid VARCHAR(100),
    hmc NUMERIC(15,2)
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
    ON invoice_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_items_product
    ON invoice_items(product_id);


-- ============================================================
-- INVOICE PAYMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    invoice_id UUID NOT NULL
        REFERENCES invoices(id) ON DELETE CASCADE,

    payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    mode VARCHAR(50) NOT NULL,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
    ON invoice_payments(invoice_id);


-- ============================================================
-- PURCHASES
-- ============================================================

CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    bill_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    supplier_id VARCHAR(100),
    supplier_name VARCHAR(255),
    supplier_gstin VARCHAR(50),

    metal VARCHAR(50) NOT NULL DEFAULT 'Gold',
    purity VARCHAR(50),
    hsn_code VARCHAR(30),

    weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    rate_per_gram NUMERIC(15,2) NOT NULL DEFAULT 0,
    making_charge NUMERIC(15,2) DEFAULT 0,

    taxable_value NUMERIC(15,2) DEFAULT 0,

    gst_pct NUMERIC(8,3) DEFAULT 0,
    cgst NUMERIC(15,2) DEFAULT 0,
    sgst NUMERIC(15,2) DEFAULT 0,
    igst NUMERIC(15,2) DEFAULT 0,

    total NUMERIC(15,2) NOT NULL DEFAULT 0,

    payment_mode VARCHAR(50) DEFAULT 'Cash',
    note TEXT,

    doc_type VARCHAR(30)
        CHECK (doc_type IN ('Entry','Order','Return','OldGold'))
        DEFAULT 'Entry',

    category VARCHAR(30)
        CHECK (category IN ('Metal','Diamond','Stone'))
        DEFAULT 'Metal',

    status VARCHAR(50) DEFAULT 'Completed',

    needs_approval BOOLEAN DEFAULT FALSE,
    approved_by VARCHAR(100),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,

    linked_doc_id VARCHAR(100),

    customer_id VARCHAR(100),
    customer_name VARCHAR(255),

    deduction_pct NUMERIC(8,3),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_date
    ON purchases(date DESC);

CREATE INDEX IF NOT EXISTS idx_purchases_supplier
    ON purchases(supplier_id);

CREATE INDEX IF NOT EXISTS idx_purchases_status
    ON purchases(status);


-- ============================================================
-- EXPENSES
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    description TEXT NOT NULL,
    category VARCHAR(150) NOT NULL,

    expense_type VARCHAR(20)
        CHECK (expense_type IN ('Direct','Indirect'))
        DEFAULT 'Indirect',

    amount NUMERIC(15,2) NOT NULL,
    date DATE NOT NULL,

    payment_mode VARCHAR(50) DEFAULT 'Cash',
    payee_name VARCHAR(255),
    voucher_no VARCHAR(100),
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date
    ON expenses(date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_category
    ON expenses(category);


-- ============================================================
-- ADVANCES
-- ============================================================

CREATE TABLE IF NOT EXISTS advances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    date DATE NOT NULL,

    customer_id VARCHAR(100),
    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30) NOT NULL,

    metal VARCHAR(20) NOT NULL
        CHECK (metal IN ('Gold','Silver')),

    purity VARCHAR(50) NOT NULL,

    rate_per_gram NUMERIC(15,2) NOT NULL,
    amount NUMERIC(15,2) NOT NULL,
    weight_locked NUMERIC(15,3) NOT NULL,

    note TEXT,

    status VARCHAR(20)
        CHECK (status IN ('Active','Redeemed','Cancelled'))
        DEFAULT 'Active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advances_customer
    ON advances(customer_id);

CREATE INDEX IF NOT EXISTS idx_advances_status
    ON advances(status);


-- ============================================================
-- GIRVI
-- ============================================================

CREATE TABLE IF NOT EXISTS girvi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    date DATE NOT NULL,
    loan_no VARCHAR(100) NOT NULL,

    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),
    customer_mobile2 VARCHAR(30),
    customer_address TEXT,

    item_type VARCHAR(100),
    item_category VARCHAR(100),
    item_description TEXT,

    gross_weight NUMERIC(15,3),
    net_weight NUMERIC(15,3),
    purity VARCHAR(50),
    market_value NUMERIC(15,2),

    loan_amount NUMERIC(15,2) NOT NULL,
    interest_pct NUMERIC(8,3) NOT NULL,

    document_type VARCHAR(100),
    document_number VARCHAR(150),
    image_url TEXT,

    due_date DATE,

    status VARCHAR(50) NOT NULL DEFAULT 'Active',

    forwarded_to VARCHAR(255),
    forwarded_shop_name VARCHAR(255),
    forwarded_shop_gst_no VARCHAR(50),
    forwarded_shop_address TEXT,
    forwarded_date DATE,
    forwarded_amount NUMERIC(15,2),
    forwarded_interest_pct NUMERIC(8,3),

    is_forwarded_settled BOOLEAN DEFAULT FALSE,
    forwarded_settled_date DATE,
    forwarded_settled_interest NUMERIC(15,2),
    forwarded_image_url TEXT,

    customer_signature TEXT,
    authorized_signatory TEXT,
    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_girvi_loan_no
    ON girvi(loan_no);

CREATE INDEX IF NOT EXISTS idx_girvi_customer_mobile
    ON girvi(customer_mobile);

CREATE INDEX IF NOT EXISTS idx_girvi_status
    ON girvi(status);


-- ============================================================
-- GIRVI ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS girvi_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    girvi_id UUID NOT NULL
        REFERENCES girvi(id) ON DELETE CASCADE,

    item_type VARCHAR(100) NOT NULL,
    item_category VARCHAR(100),
    item_description TEXT NOT NULL,

    gross_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    net_weight NUMERIC(15,3) NOT NULL DEFAULT 0,

    purity VARCHAR(50) NOT NULL,
    market_value NUMERIC(15,2)
);

CREATE INDEX IF NOT EXISTS idx_girvi_items_girvi
    ON girvi_items(girvi_id);


-- ============================================================
-- ORDERS
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    order_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),
    customer_address TEXT,

    item_description TEXT NOT NULL,

    metal VARCHAR(50) NOT NULL DEFAULT 'Gold',
    purity VARCHAR(50) DEFAULT '22K',

    expected_gross_weight NUMERIC(15,3) DEFAULT 0,
    expected_net_weight NUMERIC(15,3) DEFAULT 0,

    size_length VARCHAR(100),

    hallmark_required BOOLEAN DEFAULT TRUE,

    rate_lock_status VARCHAR(20)
        CHECK (rate_lock_status IN ('Locked','Open'))
        DEFAULT 'Locked',

    locked_gold_rate NUMERIC(15,2) DEFAULT 0,

    old_gold_weight NUMERIC(15,3) DEFAULT 0,
    old_gold_purity VARCHAR(50) DEFAULT '22K',
    old_gold_valuation NUMERIC(15,2) DEFAULT 0,

    making_charge NUMERIC(15,2) DEFAULT 0,
    wastage_pct NUMERIC(8,3) DEFAULT 0,

    estimated_total_amount NUMERIC(15,2) DEFAULT 0,
    fixed_price NUMERIC(15,2) DEFAULT 0,
    advance_paid NUMERIC(15,2) DEFAULT 0,

    karigar_id VARCHAR(100),

    due_date DATE,

    status VARCHAR(50) DEFAULT 'Pending',

    note TEXT,
    sample_image_url TEXT,

    customer_signature TEXT,
    authorized_signatory TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_order_no
    ON orders(order_no);

CREATE INDEX IF NOT EXISTS idx_orders_customer_mobile
    ON orders(customer_mobile);

CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status);


-- ============================================================
-- REPAIRS
-- ============================================================

CREATE TABLE IF NOT EXISTS repairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    ticket_no VARCHAR(100) NOT NULL,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),
    customer_mobile2 VARCHAR(30),
    customer_address TEXT,

    category VARCHAR(100),
    design VARCHAR(255),
    repair_type VARCHAR(150),

    metal VARCHAR(50)
        CHECK (metal IN ('Gold','Silver','Diamond','Platinum','Other'))
        DEFAULT 'Gold',

    purity VARCHAR(50),

    item_description TEXT,

    item_weight NUMERIC(15,3) DEFAULT 0,
    received_weight NUMERIC(15,3) DEFAULT 0,
    delivered_weight NUMERIC(15,3) DEFAULT 0,
    gold_added_weight NUMERIC(15,3) DEFAULT 0,

    problem TEXT,

    estimated_cost NUMERIC(15,2) DEFAULT 0,
    actual_cost NUMERIC(15,2) DEFAULT 0,
    karigar_labour_charge NUMERIC(15,2) DEFAULT 0,
    advance NUMERIC(15,2) DEFAULT 0,

    expected_date DATE,
    delivery_date DATE,

    karigar_id VARCHAR(100),

    status VARCHAR(30)
        CHECK (status IN ('Received','In Progress','Ready','Delivered'))
        DEFAULT 'Received',

    before_photo_url TEXT,
    after_photo_url TEXT,

    note TEXT,

    customer_signature TEXT,
    authorized_signatory TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repairs_ticket_no
    ON repairs(ticket_no);

CREATE INDEX IF NOT EXISTS idx_repairs_customer_mobile
    ON repairs(customer_mobile);

CREATE INDEX IF NOT EXISTS idx_repairs_status
    ON repairs(status);


-- ============================================================
-- SALES RETURNS
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    return_no VARCHAR(100) NOT NULL UNIQUE,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    invoice_id VARCHAR(100),
    invoice_number VARCHAR(100),

    customer_id VARCHAR(100),
    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),

    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    gst_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_refund NUMERIC(15,2) NOT NULL DEFAULT 0,

    refund_mode VARCHAR(30) NOT NULL
        CHECK (
            refund_mode IN
            ('Cash','UPI','Card','Adjust Dues','Store Credit')
        ),

    reason TEXT,
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice
    ON sales_returns(invoice_id);

CREATE INDEX IF NOT EXISTS idx_sales_returns_customer
    ON sales_returns(customer_id);


-- ============================================================
-- SALES RETURN ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    sales_return_id UUID NOT NULL
        REFERENCES sales_returns(id) ON DELETE CASCADE,

    product_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,

    purity VARCHAR(50),

    net_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    gross_weight NUMERIC(15,3),
    stone_weight NUMERIC(15,3),

    rate_per_gram NUMERIC(15,2) NOT NULL DEFAULT 0,
    making_charge NUMERIC(15,2) DEFAULT 0,
    gst_pct NUMERIC(8,3) DEFAULT 0,

    qty NUMERIC(15,3) NOT NULL DEFAULT 1,

    huid VARCHAR(100),

    return_amount NUMERIC(15,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return
    ON sales_return_items(sales_return_id);


-- ============================================================
-- SCHEMES
-- ============================================================

CREATE TABLE IF NOT EXISTS schemes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    scheme_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(30),

    plan_name VARCHAR(255) NOT NULL,

    monthly_amount NUMERIC(15,2) NOT NULL,
    tenure_months INTEGER NOT NULL,

    paid_months INTEGER DEFAULT 0,
    total_paid NUMERIC(15,2) DEFAULT 0,

    maturity_date DATE,

    status VARCHAR(50) DEFAULT 'Active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schemes_scheme_no
    ON schemes(scheme_no);

CREATE INDEX IF NOT EXISTS idx_schemes_customer_mobile
    ON schemes(customer_mobile);

CREATE INDEX IF NOT EXISTS idx_schemes_status
    ON schemes(status);


-- ============================================================
-- STOCK ADJUSTMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    adjustment_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    item_id VARCHAR(100) NOT NULL,
    item_code VARCHAR(100) NOT NULL,
    item_name VARCHAR(255) NOT NULL,

    type VARCHAR(20) NOT NULL
        CHECK (type IN ('INCREASE','DECREASE')),

    qty NUMERIC(15,3) NOT NULL DEFAULT 1,
    gross_weight NUMERIC(15,3) DEFAULT 0,
    net_weight NUMERIC(15,3) DEFAULT 0,

    reason TEXT NOT NULL,
    remarks TEXT,

    created_by VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_item
    ON stock_adjustments(item_id);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_date
    ON stock_adjustments(date DESC);


-- ============================================================
-- STOCK TRANSFERS
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    transfer_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    item_id VARCHAR(100) NOT NULL,
    item_code VARCHAR(100) NOT NULL,
    item_name VARCHAR(255) NOT NULL,

    from_branch VARCHAR(150) NOT NULL,
    to_branch VARCHAR(150) NOT NULL,

    from_godown VARCHAR(150),
    to_godown VARCHAR(150),

    qty NUMERIC(15,3) NOT NULL DEFAULT 1,
    gross_weight NUMERIC(15,3) DEFAULT 0,
    net_weight NUMERIC(15,3) DEFAULT 0,

    status VARCHAR(20)
        CHECK (status IN ('Completed','Pending','Cancelled'))
        DEFAULT 'Completed',

    remarks TEXT,
    created_by VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_item
    ON stock_transfers(item_id);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_date
    ON stock_transfers(date DESC);


-- ============================================================
-- STOCK LEDGER
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    date DATE NOT NULL,

    item_id VARCHAR(100) NOT NULL,
    item_code VARCHAR(100) NOT NULL,
    item_name VARCHAR(255) NOT NULL,

    transaction_type VARCHAR(30) NOT NULL
        CHECK (
            transaction_type IN (
                'OPENING',
                'PURCHASE',
                'SALE',
                'TRANSFER',
                'ADJUSTMENT',
                'REPAIR',
                'MANUFACTURING',
                'RETURN'
            )
        ),

    qty_change NUMERIC(15,3) NOT NULL DEFAULT 0,
    gross_weight_change NUMERIC(15,3) DEFAULT 0,
    net_weight_change NUMERIC(15,3) DEFAULT 0,

    balance_qty NUMERIC(15,3) NOT NULL DEFAULT 0,
    balance_gross_weight NUMERIC(15,3) DEFAULT 0,
    balance_net_weight NUMERIC(15,3) DEFAULT 0,

    reference_no VARCHAR(100),
    remarks TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_item
    ON stock_ledger(item_id);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_date
    ON stock_ledger(date DESC);


-- ============================================================
-- OPENING STOCK
-- ============================================================

CREATE TABLE IF NOT EXISTS opening_stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    entry_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    item_id VARCHAR(100) NOT NULL,
    item_code VARCHAR(100) NOT NULL,
    item_name VARCHAR(255) NOT NULL,

    qty NUMERIC(15,3) NOT NULL DEFAULT 1,
    gross_weight NUMERIC(15,3) DEFAULT 0,
    net_weight NUMERIC(15,3) DEFAULT 0,

    rate NUMERIC(15,2) DEFAULT 0,
    total_value NUMERIC(15,2) DEFAULT 0,

    remarks TEXT,
    created_by VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opening_stock_item
    ON opening_stock(item_id);


-- ============================================================
-- COUNTERS
-- ============================================================

CREATE TABLE IF NOT EXISTS counters (
    id VARCHAR(100) PRIMARY KEY,
    seq BIGINT NOT NULL DEFAULT 0
);


-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'gold_rates',
        'inventory',
        'sales',
        'invoices',
        'invoice_payments',
        'purchases',
        'expenses',
        'advances',
        'girvi',
        'orders',
        'repairs',
        'sales_returns',
        'schemes',
        'stock_adjustments',
        'stock_transfers',
        'stock_ledger',
        'opening_stock'
    ]
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I',
            tbl, tbl
        );

        EXECUTE format(
            'CREATE TRIGGER trg_%I_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW
             EXECUTE FUNCTION set_updated_at()',
            tbl, tbl
        );
    END LOOP;
END $$;


COMMIT;
