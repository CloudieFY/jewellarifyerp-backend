BEGIN;

CREATE TABLE IF NOT EXISTS jobworks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    shop_id TEXT NOT NULL
        REFERENCES shops(id) ON DELETE CASCADE,

    job_no VARCHAR(100) NOT NULL,
    date DATE NOT NULL,

    karigar_id VARCHAR(100) NOT NULL,
    karigar_name VARCHAR(255) NOT NULL,

    item_description TEXT NOT NULL,

    metal VARCHAR(50) NOT NULL DEFAULT 'Gold',
    purity VARCHAR(50) NOT NULL DEFAULT '22K',

    issued_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    received_weight NUMERIC(15,3) NOT NULL DEFAULT 0,
    wastage NUMERIC(15,3) NOT NULL DEFAULT 0,

    making_charge NUMERIC(15,2) NOT NULL DEFAULT 0,

    due_date DATE,

    status VARCHAR(30) NOT NULL DEFAULT 'Issued'
        CHECK (status IN ('Issued', 'In Progress', 'Received', 'Settled')),

    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobworks_shop
    ON jobworks(shop_id);

CREATE INDEX IF NOT EXISTS idx_jobworks_shop_job_no
    ON jobworks(shop_id, job_no);

CREATE INDEX IF NOT EXISTS idx_jobworks_shop_karigar
    ON jobworks(shop_id, karigar_id);

CREATE INDEX IF NOT EXISTS idx_jobworks_shop_status
    ON jobworks(shop_id, status);

COMMIT;
