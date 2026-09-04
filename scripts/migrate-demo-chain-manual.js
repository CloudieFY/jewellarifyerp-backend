/*
 * ONE-OFF MANUAL MIGRATION -- Demo "chain" (Mongo _id 6a7c5c7d09dc3c8b01d71213).
 *
 * This is NOT a general-purpose script. It exists to migrate exactly ONE
 * Mongo stockledgers record that a human manually confirmed the mapping
 * for (scripts/analyze-stock-ledger-review.js classified it Category A --
 * "SAFE AFTER MANUAL MAPPING" -- because it matched two PostgreSQL items by
 * name and the audit refused to auto-pick one).
 *
 * The confirmed mapping (see conversation): PostgreSQL inventory
 * ae7cbe2a-0428-4a6c-b89f-45e355475ed8, chosen because its created_at
 * (2026-08-12 11:43:57.634+00) matches the source Mongo document's
 * createdAt to the millisecond -- not by name or by stock/weight coincidence.
 *
 * Hard-coded, single-row, defensively guarded:
 *   - Verifies the backup exists before doing anything.
 *   - Re-verifies the target inventory row's identity (id/name/stock/
 *     gross_weight/net_weight) immediately before writing; aborts otherwise.
 *   - Checks for a pre-existing duplicate using the same dedup key as the
 *     general migration; skips the insert if already present (idempotent).
 *   - Single transaction; ROLLBACK on any verification failure.
 *   - Never touches inventory, never touches Mongo.
 *
 * Usage:
 *   node scripts/migrate-demo-chain-manual.js              (dry run)
 *   node scripts/migrate-demo-chain-manual.js --execute      (writes for real)
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const EXECUTE = process.argv.includes('--execute');
const BACKUP_PATH = path.join(os.homedir(), 'jewellarify-backups', 'before-stock-ledger-migration.dump');

const SHOP_ID = '6a718b3b4dc2277b0539b1e0'; // demo
const TARGET_INVENTORY_ID = 'ae7cbe2a-0428-4a6c-b89f-45e355475ed8';
const EXPECTED_INVENTORY = { name: 'chain', stock: 9, gross_weight: 0, net_weight: 0 };

const RECORD = {
  date: '2026-08-12',
  itemCode: '6a7c5c7d09dc3c8b01d71213', // Mongo item had no real code; itemCode == its own Mongo _id
  itemName: 'chain',
  transactionType: 'SALE',
  qtyChange: -1,
  grossWeightChange: -100,
  netWeightChange: -90,
  balanceQty: 9,
  balanceGrossWeight: 0,
  balanceNetWeight: 0,
  referenceNo: 'INV-0001',
  remarks: 'Sales Invoice Stock Deduction',
  createdAt: new Date('2026-08-12T13:05:45.505Z'),
  updatedAt: new Date('2026-08-12T13:05:45.505Z')
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fail(msg) {
  throw new Error(`SAFETY CHECK FAILED: ${msg}`);
}

function assertBackupExists() {
  if (!fs.existsSync(BACKUP_PATH)) {
    fail(`backup not found at ${BACKUP_PATH}`);
  }
  const stat = fs.statSync(BACKUP_PATH);
  if (stat.size < 1024) {
    fail(`backup at ${BACKUP_PATH} is suspiciously small (${stat.size} bytes)`);
  }
  console.log(`✓ Backup verified: ${BACKUP_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
}

async function verifyTargetInventoryRow(client) {
  const res = await client.query(
    `SELECT id, name, stock, gross_weight, net_weight FROM inventory WHERE id = $1`,
    [TARGET_INVENTORY_ID]
  );

  if (res.rowCount !== 1) {
    fail(`target inventory row ${TARGET_INVENTORY_ID} not found`);
  }

  const row = res.rows[0];
  if (row.name !== EXPECTED_INVENTORY.name) {
    fail(`inventory.name mismatch: expected "${EXPECTED_INVENTORY.name}", got "${row.name}"`);
  }
  if (!(Math.abs(num(row.stock) - EXPECTED_INVENTORY.stock) < 0.001)) {
    fail(`inventory.stock mismatch: expected ${EXPECTED_INVENTORY.stock}, got ${row.stock}`);
  }
  if (!(Math.abs(num(row.gross_weight) - EXPECTED_INVENTORY.gross_weight) < 0.001)) {
    fail(`inventory.gross_weight mismatch: expected ${EXPECTED_INVENTORY.gross_weight}, got ${row.gross_weight}`);
  }
  if (!(Math.abs(num(row.net_weight) - EXPECTED_INVENTORY.net_weight) < 0.001)) {
    fail(`inventory.net_weight mismatch: expected ${EXPECTED_INVENTORY.net_weight}, got ${row.net_weight}`);
  }

  console.log(`✓ Target inventory row verified: id=${row.id} name=${row.name} stock=${row.stock} gross_weight=${row.gross_weight} net_weight=${row.net_weight}`);
  return row;
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function fmt3(n) {
  return num(n).toFixed(3);
}
function dedupKey(shopId, itemId, txType, qty, gross, net, refNo, remarks) {
  return [
    shopId, itemId, normalizeText(txType),
    fmt3(qty), fmt3(gross), fmt3(net),
    normalizeText(refNo), normalizeText(remarks)
  ].join('|');
}

async function checkDuplicate(client) {
  const res = await client.query(
    `SELECT id, shop_id, item_id, transaction_type, qty_change, gross_weight_change,
            net_weight_change, reference_no, remarks
     FROM stock_ledger
     WHERE shop_id = $1 AND item_id = $2`,
    [SHOP_ID, TARGET_INVENTORY_ID]
  );

  const wantedKey = dedupKey(
    SHOP_ID, TARGET_INVENTORY_ID, RECORD.transactionType,
    RECORD.qtyChange, RECORD.grossWeightChange, RECORD.netWeightChange,
    RECORD.referenceNo, RECORD.remarks
  );

  for (const row of res.rows) {
    const existingKey = dedupKey(
      row.shop_id, row.item_id, row.transaction_type,
      row.qty_change, row.gross_weight_change, row.net_weight_change,
      row.reference_no, row.remarks
    );
    if (existingKey === wantedKey) {
      return row;
    }
  }
  return null;
}

async function main() {
  console.log('========================================');
  console.log(`DEMO "chain" MANUAL MIGRATION -- ${EXECUTE ? 'EXECUTE MODE (writes will commit)' : 'DRY RUN (no writes)'}`);
  console.log('========================================\n');

  assertBackupExists();

  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const beforeCountRes = await pg.query('SELECT count(*)::int AS c FROM stock_ledger');
    const beforeCount = beforeCountRes.rows[0].c;
    console.log(`\nstock_ledger count before: ${beforeCount}`);

    const client = await pg.connect();
    let outcome = null;

    try {
      await client.query('BEGIN');

      await verifyTargetInventoryRow(client);

      const dup = await checkDuplicate(client);
      if (dup) {
        console.log(`\n↻ Duplicate already exists (id=${dup.id}) -- this record was already migrated. No insert will be performed.`);
        outcome = { inserted: false, reason: 'ALREADY_MIGRATED', existingId: dup.id };
        await client.query('ROLLBACK');
      } else if (!EXECUTE) {
        console.log('\n✓ No duplicate found. Would insert 1 row (dry run -- not executing).');
        outcome = { inserted: false, reason: 'DRY_RUN' };
        await client.query('ROLLBACK');
      } else {
        const insertRes = await client.query(
          `INSERT INTO stock_ledger (
             date, item_id, item_code, item_name, transaction_type,
             qty_change, gross_weight_change, net_weight_change,
             balance_qty, balance_gross_weight, balance_net_weight,
             reference_no, remarks, shop_id, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9, $10, $11,
             $12, $13, $14, $15, $16
           )
           RETURNING id`,
          [
            RECORD.date,
            TARGET_INVENTORY_ID,
            RECORD.itemCode,
            RECORD.itemName,
            RECORD.transactionType,
            RECORD.qtyChange,
            RECORD.grossWeightChange,
            RECORD.netWeightChange,
            RECORD.balanceQty,
            RECORD.balanceGrossWeight,
            RECORD.balanceNetWeight,
            RECORD.referenceNo,
            RECORD.remarks,
            SHOP_ID,
            RECORD.createdAt,
            RECORD.updatedAt
          ]
        );

        const insertedId = insertRes.rows[0].id;
        console.log(`\n✓ INSERTED [${insertedId}]`);
        outcome = { inserted: true, insertedId };

        await client.query('COMMIT');
        console.log('✓ Transaction committed.');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('\n✗ Error during transaction -- ROLLED BACK.');
      throw error;
    } finally {
      client.release();
    }

    // ---- Post-verification (outside the write transaction, fresh reads) ----
    console.log('\n========================================');
    console.log('POST-VERIFICATION');
    console.log('========================================');

    const afterCountRes = await pg.query('SELECT count(*)::int AS c FROM stock_ledger');
    const afterCount = afterCountRes.rows[0].c;
    const expectedAfter = outcome.inserted ? beforeCount + 1 : beforeCount;
    const countOk = afterCount === expectedAfter;
    console.log(`stock_ledger count after: ${afterCount} (expected ${expectedAfter}) -- ${countOk ? 'OK' : 'MISMATCH'}`);

    if (outcome.inserted) {
      const rowRes = await pg.query('SELECT * FROM stock_ledger WHERE id = $1', [outcome.insertedId]);
      const row = rowRes.rows[0];
      const checks = {
        shop_id: row.shop_id === SHOP_ID,
        item_id: row.item_id === TARGET_INVENTORY_ID,
        transaction_type: row.transaction_type === RECORD.transactionType,
        qty_change: Math.abs(num(row.qty_change) - RECORD.qtyChange) < 0.001,
        gross_weight_change: Math.abs(num(row.gross_weight_change) - RECORD.grossWeightChange) < 0.001,
        net_weight_change: Math.abs(num(row.net_weight_change) - RECORD.netWeightChange) < 0.001,
        balance_qty: Math.abs(num(row.balance_qty) - RECORD.balanceQty) < 0.001,
        balance_gross_weight: Math.abs(num(row.balance_gross_weight) - RECORD.balanceGrossWeight) < 0.001,
        balance_net_weight: Math.abs(num(row.balance_net_weight) - RECORD.balanceNetWeight) < 0.001,
        reference_no: row.reference_no === RECORD.referenceNo,
        remarks: row.remarks === RECORD.remarks,
        date: row.date.toISOString().slice(0, 10) === RECORD.date
      };
      console.log('\nInserted row exact-value check:');
      for (const [field, ok] of Object.entries(checks)) {
        console.log(`  ${field}: ${ok ? 'OK' : 'MISMATCH'}`);
      }
      const allOk = Object.values(checks).every(Boolean);
      console.log(`\nAll fields correct: ${allOk ? 'YES' : 'NO'}`);
    }

    const dupCheckRes = await pg.query(
      `SELECT count(*)::int AS c FROM stock_ledger WHERE shop_id = $1 AND item_id = $2 AND transaction_type = $3 AND reference_no = $4`,
      [SHOP_ID, TARGET_INVENTORY_ID, RECORD.transactionType, RECORD.referenceNo]
    );
    console.log(`\nRows matching (shop_id, item_id, transaction_type, reference_no): ${dupCheckRes.rows[0].c} (expected exactly 1) -- ${dupCheckRes.rows[0].c === 1 ? 'OK, no duplicates' : 'MISMATCH'}`);

    const invRes = await pg.query(
      `SELECT id, name, stock, gross_weight, net_weight, updated_at FROM inventory WHERE id = $1`,
      [TARGET_INVENTORY_ID]
    );
    const invRow = invRes.rows[0];
    const invUnchanged =
      invRow.name === EXPECTED_INVENTORY.name &&
      Math.abs(num(invRow.stock) - EXPECTED_INVENTORY.stock) < 0.001 &&
      Math.abs(num(invRow.gross_weight) - EXPECTED_INVENTORY.gross_weight) < 0.001 &&
      Math.abs(num(invRow.net_weight) - EXPECTED_INVENTORY.net_weight) < 0.001;
    console.log(`\ninventory row unchanged: stock=${invRow.stock} gross_weight=${invRow.gross_weight} net_weight=${invRow.net_weight} -- ${invUnchanged ? 'OK, untouched' : 'MISMATCH'}`);

    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`Mode: ${EXECUTE ? 'EXECUTED' : 'DRY RUN'}`);
    console.log(`Outcome: ${JSON.stringify(outcome)}`);
    console.log(`stock_ledger: ${beforeCount} -> ${afterCount}`);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error('\n========================================');
  console.error('MIGRATION FAILED (transaction rolled back)');
  console.error('========================================');
  console.error(error);
  process.exitCode = 1;
});
