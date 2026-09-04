-- ============================================================
-- 006 RELAX CORE CHECK CONSTRAINTS
-- The initial schema added CHECK constraints that are stricter than what the
-- Mongo app enforced, so faithfully-migrated data / real request payloads
-- would be rejected. Bring them in line with actual behaviour.
-- Idempotent.
-- ============================================================

BEGIN;

-- invoices.payment_mode: the Mongo schema field was a plain String (no enum);
-- the app sends free-form values like 'Pending', 'Adjusted in Bill',
-- 'UPI / Cash', 'UPI + Cash'. Drop the enum CHECK entirely.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_mode_check;

-- supplier_transactions.kind: Mongo enum was ['Weight','Payment','Dual'].
ALTER TABLE supplier_transactions DROP CONSTRAINT IF EXISTS supplier_transactions_kind_check;
ALTER TABLE supplier_transactions
  ADD CONSTRAINT supplier_transactions_kind_check
  CHECK (kind IS NULL OR (kind)::text = ANY (ARRAY['Weight','Payment','Dual']));

-- supplier_transactions.metal: Mongo enum was ['Gold','Silver','Both'].
ALTER TABLE supplier_transactions DROP CONSTRAINT IF EXISTS supplier_transactions_metal_check;
ALTER TABLE supplier_transactions
  ADD CONSTRAINT supplier_transactions_metal_check
  CHECK (metal IS NULL OR (metal)::text = ANY (ARRAY['Gold','Silver','Both']));

COMMIT;
