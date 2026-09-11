-- ============================================================
-- 016 CRM QUOTATION FOUNDATION (Slice 4)
--
-- ADDITIVE ONLY. New table crm_quotation. Same tenant-safety model as every
-- prior CRM table.
--
-- Audited before writing this (see Slice 4 plan): no quotation/estimate
-- entity exists anywhere in the backend. `orders` is a custom-manufacturing
-- production record (karigar assignment, rate-lock, weight tracking), not a
-- sales-proposal document -- reusing it would conflate two different
-- business processes. `invoices` has no draft/pre-sale state (NON-GST is
-- still a final, numbered invoice). A new, minimal CRM entity is genuinely
-- required. This is a FOUNDATION only: a single `amount` total, no
-- line-items table, no bridge into orders/invoices/payments (explicitly
-- out of scope this slice) -- `orders`/`invoices` are NOT touched or
-- duplicated by this migration.
--
-- opportunity_id is NOT NULL: a quotation only exists in the context of a
-- specific deal (per the approved Lead -> Opportunity -> Quotation
-- relationship), so ON DELETE CASCADE mirrors that -- a quotation cannot
-- outlive the opportunity it quotes (opportunities are soft-deleted via
-- deleted_at in normal app operation; CASCADE only matters for a manual
-- hard delete). customer_id is an independently-nullable denormalized
-- convenience FK, exactly mirroring how crm_opportunity.customer_id already
-- denormalizes rather than requiring a join through crm_lead.
--
-- Idempotent: IF NOT EXISTS / DROP-IF-EXISTS-then-CREATE throughout.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS crm_quotation (
    id             text PRIMARY KEY,
    shop_id        text NOT NULL REFERENCES shops(id)          ON DELETE CASCADE,
    branch_id      text REFERENCES branches(id)                ON DELETE SET NULL,
    opportunity_id text NOT NULL REFERENCES crm_opportunity(id) ON DELETE CASCADE,
    customer_id    text REFERENCES customers(id)                ON DELETE SET NULL,
    assigned_to    text REFERENCES users(id)                   ON DELETE SET NULL,
    created_by     text REFERENCES users(id)                   ON DELETE SET NULL,

    title          varchar(255) NOT NULL,
    amount         numeric(14,2),
    status         varchar(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','sent','accepted','rejected','expired')),
    valid_until    date,
    notes          text,

    sent_at        timestamptz,
    accepted_at    timestamptz,
    rejected_at    timestamptz,

    last_activity_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop            ON crm_quotation(shop_id);
CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop_status     ON crm_quotation(shop_id, status)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop_opportunity ON crm_quotation(shop_id, opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop_customer   ON crm_quotation(shop_id, customer_id)    WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop_assigned   ON crm_quotation(shop_id, assigned_to)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_quotation_shop_created    ON crm_quotation(shop_id, created_at DESC);

ALTER TABLE crm_quotation ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_quotation FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_quotation_tenant_isolation ON crm_quotation;
CREATE POLICY crm_quotation_tenant_isolation ON crm_quotation
  USING      (shop_id = current_setting('app.shop_id', true))
  WITH CHECK (shop_id = current_setting('app.shop_id', true));

DROP POLICY IF EXISTS crm_quotation_superadmin_read ON crm_quotation;
CREATE POLICY crm_quotation_superadmin_read ON crm_quotation
  FOR SELECT
  USING (current_setting('app.crm_admin_ctx', true) = 'on');

-- ------------------------------------------------------------
-- crm_activity: widen the polymorphic timeline to cover quotations too.
-- ------------------------------------------------------------
ALTER TABLE crm_activity DROP CONSTRAINT IF EXISTS crm_activity_entity_type_check;
ALTER TABLE crm_activity
  ADD CONSTRAINT crm_activity_entity_type_check
  CHECK (entity_type IN ('lead','customer','opportunity','task','demo','quotation'));

COMMIT;
