BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- MASTER / CONTROL PLANE
-- =========================================================

CREATE TABLE IF NOT EXISTS superadmins (
    id TEXT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shops (
    id TEXT PRIMARY KEY,
    slug VARCHAR(150) NOT NULL UNIQUE,
    shop_name VARCHAR(255) NOT NULL,
    owner_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    logo_url TEXT,
    address TEXT,
    gst_number VARCHAR(100),
    number_of_shop_owner VARCHAR(100),
    insta_id VARCHAR(255),
    fb_id VARCHAR(255),
    terms_and_conditions TEXT,
    invoice_settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    plan VARCHAR(20) NOT NULL DEFAULT 'trial'
        CHECK (plan IN ('trial', 'basic', 'standard', 'premium')),

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'expired')),

    subscription_start_date TIMESTAMPTZ NOT NULL,
    subscription_end_date TIMESTAMPTZ NOT NULL,

    initial_admin_username VARCHAR(100) NOT NULL,
    initial_operator_username VARCHAR(100),

    -- Kept temporarily for migration/reference.
    -- PostgreSQL itself will not use this for tenant routing.
    legacy_db_name VARCHAR(255),

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS demo_requests (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    shop_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    address TEXT,
    message TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Contacted', 'Closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- TENANT USERS
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    username VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL,
    password_encrypted TEXT,

    name VARCHAR(255) NOT NULL,

    role VARCHAR(20) NOT NULL
        CHECK (role IN ('owner', 'operator', 'karigar')),

    karigar_ref_id TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    preferred_language VARCHAR(10) DEFAULT 'en',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(shop_id, username)
);

-- =========================================================
-- CUSTOMERS
-- =========================================================

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    phone2 VARCHAR(50),
    address TEXT NOT NULL,
    gst_number VARCHAR(100),
    pan VARCHAR(50),
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_shop
    ON customers(shop_id);

CREATE INDEX IF NOT EXISTS idx_customers_shop_phone
    ON customers(shop_id, phone);

CREATE INDEX IF NOT EXISTS idx_customers_shop_name
    ON customers(shop_id, name);

-- =========================================================
-- EMPLOYEES
-- =========================================================

CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    role VARCHAR(100) NOT NULL,
    salary NUMERIC(18,2) NOT NULL DEFAULT 0,
    join_date VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Active',
    total_paid NUMERIC(18,2) NOT NULL DEFAULT 0,

    notes TEXT,
    aadhaar VARCHAR(100),
    pan VARCHAR(50),
    bank_details TEXT,
    upi_id VARCHAR(255),
    address TEXT,

    payments JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_shop
    ON employees(shop_id);

-- =========================================================
-- SUPPLIERS
-- =========================================================

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    company VARCHAR(255),
    mobile VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    category VARCHAR(100),
    gst_number VARCHAR(100),
    address TEXT,
    company_no VARCHAR(100),
    note TEXT,

    outstanding NUMERIC(18,2) NOT NULL DEFAULT 0,
    balance_gold NUMERIC(18,4) NOT NULL DEFAULT 0,
    balance_silver NUMERIC(18,4) NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_transactions (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

    date VARCHAR(50) NOT NULL,

    type VARCHAR(20) NOT NULL
        CHECK (type IN ('Credit', 'Debit')),

    kind VARCHAR(20) NOT NULL DEFAULT 'Weight'
        CHECK (kind IN ('Weight', 'Payment')),

    metal VARCHAR(20)
        CHECK (metal IN ('Gold', 'Silver')),

    purity VARCHAR(50),
    weight NUMERIC(18,4),
    amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    payment_mode VARCHAR(50),
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_supplier_transactions_shop_supplier
    ON supplier_transactions(shop_id, supplier_id);

-- =========================================================
-- KARIGARS
-- =========================================================

CREATE TABLE IF NOT EXISTS karigars (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    mobile VARCHAR(50) NOT NULL,
    company_name VARCHAR(255),
    email VARCHAR(255),
    category VARCHAR(100),
    specialty VARCHAR(255),
    gst_number VARCHAR(100),
    address TEXT,
    note TEXT,

    pending_weight NUMERIC(18,4) NOT NULL DEFAULT 0,

    username VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_karigars_shop
    ON karigars(shop_id);

-- =========================================================
-- INVENTORY MASTERS
-- =========================================================

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    code VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(shop_id, code)
);

CREATE TABLE IF NOT EXISTS subcategories (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    category_id TEXT NOT NULL,
    category_name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(shop_id, code)
);

CREATE TABLE IF NOT EXISTS brands (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    code VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(shop_id, code)
);

CREATE TABLE IF NOT EXISTS collection_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    code VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(shop_id, code)
);

CREATE TABLE IF NOT EXISTS purity_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    metal_type VARCHAR(100) NOT NULL DEFAULT 'Gold',
    purity_percentage NUMERIC(8,3) NOT NULL DEFAULT 91.6,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metal_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    code VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stone_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL DEFAULT 'Precious',
    color VARCHAR(100),
    default_rate NUMERIC(18,2) NOT NULL DEFAULT 0,
    unit VARCHAR(50) NOT NULL DEFAULT 'Carat',
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS diamond_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    shape VARCHAR(100) NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT 'G',
    clarity VARCHAR(50) NOT NULL DEFAULT 'VS1',
    default_rate_per_carat NUMERIC(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS unit_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hsn_masters (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

    hsn_code VARCHAR(50) NOT NULL,
    gst_pct NUMERIC(8,3) NOT NULL DEFAULT 3,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
