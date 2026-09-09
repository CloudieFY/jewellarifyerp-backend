-- ============================================================
-- 008 CRM FOUNDATION (Phase 0)
--
-- Prepares the PostgreSQL stack for the CRM module. This migration is
-- ADDITIVE ONLY:
--   * new tables: branches, user_branches, crm_audit_log, crm_outbox,
--     crm_notification
--   * new NULLABLE / defaulted columns on `users`: crm_role, permissions
--
-- It does NOT touch the Mongo stack, does NOT alter or drop any existing
-- production column/table, and does NOT change any existing API contract.
-- No CRM business tables (lead / opportunity / quotation / ...) are created
-- here — those belong to later phases.
--
-- Idempotent: every statement uses IF (NOT) EXISTS or DROP-then-ADD so the
-- runner (scripts/run-migrations.js) can re-apply it harmlessly.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. users: CRM access columns
--    - crm_role   : optional CRM persona, independent of the ERP role
--    - permissions: additive per-user permission grants (strings like
--                   'lead.view'); '{}' for everyone by default.
--    Existing owner/operator/karigar logins are unaffected.
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS crm_role    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_crm_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_crm_role_check
  CHECK (
    crm_role IS NULL
    OR crm_role IN ('crm_admin','sales_exec','demo_exec','accounting','support','dealer')
  );

-- ------------------------------------------------------------
-- 2. branches: a real per-shop branch entity.
--    CRM tables in later phases will carry a NULLABLE branch_id.
--    This does NOT change inventory.branch (free-text) semantics.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
    id          text PRIMARY KEY,
    shop_id     text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    code        varchar(50),
    status      varchar(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive')),
    phone       varchar(50),
    address     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_branches_shop
    ON branches(shop_id);

-- Branch code unique within a shop, ignoring soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_shop_code
    ON branches(shop_id, code)
    WHERE code IS NOT NULL AND deleted_at IS NULL;

-- ------------------------------------------------------------
-- 3. user_branches: which branches a user may operate in.
--    NO rows for a user  ==  user is shop-wide (all branches).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_branches (
    shop_id    text NOT NULL REFERENCES shops(id)   ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    branch_id  text NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_user_branches_shop   ON user_branches(shop_id);
CREATE INDEX IF NOT EXISTS idx_user_branches_branch ON user_branches(branch_id);

-- ------------------------------------------------------------
-- 4. crm_audit_log: tenant-scoped audit trail for CRM actions.
--    before_data / after_data / metadata are redacted by the
--    application layer (src/crm/audit/redact.ts) before insert.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_audit_log (
    id            text PRIMARY KEY,
    shop_id       text NOT NULL REFERENCES shops(id)  ON DELETE CASCADE,
    branch_id     text REFERENCES branches(id)        ON DELETE SET NULL,
    actor_user_id text REFERENCES users(id)           ON DELETE SET NULL,
    entity_type   varchar(64) NOT NULL,
    entity_id     text,
    action        varchar(64) NOT NULL,
    before_data   jsonb,
    after_data    jsonb,
    metadata      jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_audit_shop_created
    ON crm_audit_log(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_shop_entity
    ON crm_audit_log(shop_id, entity_type, entity_id);

-- ------------------------------------------------------------
-- 5. crm_outbox: transactional outbox for reliable async CRM work.
--    Written in the same transaction as the state change it reflects.
--    A worker (src/workerPg.ts) claims rows with FOR UPDATE SKIP LOCKED.
--    Phase 0 ships the table + worker skeleton only — no real actions.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_outbox (
    id            text PRIMARY KEY,
    shop_id       text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    event_type    varchar(96) NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        varchar(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed')),
    attempts      integer NOT NULL DEFAULT 0,
    max_attempts  integer NOT NULL DEFAULT 5,
    run_after     timestamptz NOT NULL DEFAULT now(),
    claimed_at    timestamptz,
    processed_at  timestamptz,
    last_error    text,
    dedupe_key    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Partial index: the worker only ever scans due, pending rows.
CREATE INDEX IF NOT EXISTS idx_crm_outbox_due
    ON crm_outbox(run_after)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crm_outbox_shop
    ON crm_outbox(shop_id);
-- Optional idempotency: caller may set dedupe_key to collapse duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_outbox_dedupe
    ON crm_outbox(shop_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- ------------------------------------------------------------
-- 6. crm_notification: in-app notification store (bell feed).
--    user_id NULL  ==  shop-wide / role-targeted notification.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_notification (
    id           text PRIMARY KEY,
    shop_id      text NOT NULL REFERENCES shops(id)  ON DELETE CASCADE,
    branch_id    text REFERENCES branches(id)        ON DELETE SET NULL,
    user_id      text REFERENCES users(id)           ON DELETE CASCADE,
    type         varchar(64) NOT NULL,
    title        varchar(255) NOT NULL,
    body         text,
    entity_type  varchar(64),
    entity_id    text,
    data         jsonb,
    read_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_notification_user
    ON crm_notification(shop_id, user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_crm_notification_shop_created
    ON crm_notification(shop_id, created_at DESC);

COMMIT;
