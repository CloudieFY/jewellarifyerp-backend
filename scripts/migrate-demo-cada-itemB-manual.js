/*
 * ONE-OFF MANUAL MIGRATION -- Demo "cada" Item B (Mongo _id 6a7ed149ce614e70acbbf026).
 *
 * This is NOT a general-purpose script. It exists to migrate exactly TWO
 * Mongo stockledgers records for a single Mongo inventory item that a human
 * manually confirmed the mapping for (scripts/audit-stock-ledger-migration.js
 * classified both records REVIEW -- "cada" collision between two Mongo
 * items [6a7b1e46e3c7d4b1d4c2a86d, 6a7ed149ce614e70acbbf026] resolving to
 * the same PostgreSQL item -- because name-matching can't disambiguate).
 *
 * The confirmed mapping (see conversation): PostgreSQL inventory
 * a75c42cc-cb81-4e3c-904a-0063008cac59, chosen because its created_at
 * (2026-08-14 08:26:49.612+00) matches Mongo item 6a7ed149ce614e70acbbf026's
 * createdAt to the millisecond -- not by name or by stock/weight coincidence.
 *
 * Mongo item 6a7b1e46e3c7d4b1d4c2a86d ("Item A", 38 ledger records) is
 * explicitly EXCLUDED from this migration -- its source inventory doc no
 * longer exists in Mongo, its ledger chain has 9 internal breaks, and its
 * reference numbers were found to be reused by unrelated later documents.
 * It is treated as orphaned/corrupted historical demo data and is not
 * touched by this script in any way.
 *
 * Hard-coded, two-row, defensively guarded:
 *   - Verifies the backup exists before doing anything.
 *   - Re-verifies the target inventory row's identity (id/name/stock/
 *     gross_weight/net_weight) immediately before writing; aborts otherwise.
 *   - Checks for pre-existing duplicates using the same dedup key as the
 *     general migration; skips any record already present (idempotent).
 *   - Single transaction for both inserts; ROLLBACK on any verification
 *     failure or partial mismatch.
 *   - Never touches inventory, never touches Mongo.
 *
 * Usage:
 *   node scripts/migrate-demo-cada-itemB-manual.js              (dry run)
 *   node scripts/migrate-demo-cada-itemB-manual.js --execute      (writes for real)
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const EXECUTE = process.argv.includes('--execute');
const BACKUP_PATH = path.join(os.homedir(), 'jewellarify-backups', 'before-item-b-cada-migration-20260817T065427Z.dump');

const SHOP_ID = '6a718b3b4dc2277b0539b1e0'; // demo
const TARGET_INVENTORY_ID = 'a75c42cc-cb81-4e3c-904a-0063008cac59';
const EXPECTED_INVENTORY = { name: 'cada', stock: 10, gross_weight: 90, net_weight: 80 };

// Exact values previously reviewed in the read-only dry run, taken verbatim
// from Mongo shop_demo.stockledgers for itemId=6a7ed149ce614e70acbbf026.
const RECORDS = [
  {
    mongoId: '6a7ed23dce614e70acbbf033',
    date: '2026-08-14',
    itemCode: '6a7ed149ce614e70acbbf026',
    itemName: 'cada',
    transactionType: 'SALE',
    qtyChange: -10,
    grossWeightChange: -100,
    netWeightChange: -90,
    balanceQty: 0,
    balanceGrossWeight: 0,
    balanceNetWeight: 0,
    referenceNo: 'INV-0006',
    remarks: 'Sales Invoice Stock Deduction',
    createdAt: new Date('2026-08-14T08:30:53.696Z'),
    updatedAt: new Date('2026-08-14T08:30:53.696Z')
  },
  {
    mongoId: '6a7ed6c51cb1e8060fe57ecb',
    date: '2026-08-14',
    itemCode: '6a7ed149ce614e70acbbf026',
    itemName: 'cada',
    transactionType: 'RETURN',
    qtyChange: 10,
    grossWeightChange: 100,
    netWeightChange: 90,
    balanceQty: 10,
    balanceGrossWeight: 100,
    balanceNetWeight: 90,
    referenceNo: 'INV-0006',
    remarks: 'Sales Invoice Return / Deletion',
    createdAt: new Date('2026-08-14T08:50:13.525Z'),
    updatedAt: new Date('2026-08-14T08:50:13.525Z')
  }
];

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

async function loadExisting(client) {
  const res = await client.query(
    `SELECT id, shop_id, item_id, transaction_type, qty_change, gross_weight_change,
            net_weight_change, reference_no, remarks
     FROM stock_ledger
     WHERE shop_id = $1 AND item_id = $2`,
    [SHOP_ID, TARGET_INVENTORY_ID]
  );
  return res.rows;
}

function findDuplicate(existingRows, rec) {
  const wantedKey = dedupKey(
    SHOP_ID, TARGET_INVENTORY_ID, rec.transactionType,
    rec.qtyChange, rec.grossWeightChange, rec.netWeightChange,
    rec.referenceNo, rec.remarks
  );
  for (const row of existingRows) {
    const existingKey = dedupKey(
      row.shop_id, row.item_id, row.transaction_type,
      row.qty_change, row.gross_weight_change, row.net_weight_change,
      row.reference_no, row.remarks
    );
    if (existingKey === wantedKey) return row;
  }
  return null;
}

async function main() {
  console.log('========================================');
  console.log(`DEMO "cada" ITEM B MANUAL MIGRATION (2 records) -- ${EXECUTE ? 'EXECUTE MODE (writes will commit)' : 'DRY RUN (no writes)'}`);
  console.log('========================================\n');

  assertBackupExists();

  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const beforeCountRes = await pg.query('SELECT count(*)::int AS c FROM stock_ledger');
    const beforeCount = beforeCountRes.rows[0].c;
    console.log(`\nstock_ledger count before: ${beforeCount}`);

    const client = await pg.connect();
    const insertedIds = [];
    let aborted = false;
    let abortReason = null;

    try {
      await client.query('BEGIN');

      await verifyTargetInventoryRow(client);

      const existingRows = await loadExisting(client);
      if (existingRows.length !== 0) {
        fail(`expected ZERO existing stock_ledger rows for shop_id=${SHOP_ID} item_id=${TARGET_INVENTORY_ID}, found ${existingRows.length}`);
      }
      console.log(`✓ Confirmed zero pre-existing stock_ledger rows for shop_id=${SHOP_ID} item_id=${TARGET_INVENTORY_ID}`);

      const dupCheckRows = [...existingRows];
      for (const rec of RECORDS) {
        const dup = findDuplicate(dupCheckRows, rec);
        if (dup) {
          fail(`duplicate detected for mongo _id=${rec.mongoId} (existing row id=${dup.id}) -- refusing to insert`);
        }
      }
      console.log(`✓ No duplicates for either of the 2 records under dedup key rules`);

      if (!EXECUTE) {
        console.log('\n✓ All preconditions pass. Would insert 2 rows (dry run -- not executing).');
        await client.query('ROLLBACK');
      } else {
        for (const rec of RECORDS) {
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
              rec.date,
              TARGET_INVENTORY_ID,
              rec.itemCode,
              rec.itemName,
              rec.transactionType,
              rec.qtyChange,
              rec.grossWeightChange,
              rec.netWeightChange,
              rec.balanceQty,
              rec.balanceGrossWeight,
              rec.balanceNetWeight,
              rec.referenceNo,
              rec.remarks,
              SHOP_ID,
              rec.createdAt,
              rec.updatedAt
            ]
          );
          const insertedId = insertRes.rows[0].id;
          console.log(`✓ INSERTED [${insertedId}] for mongo _id=${rec.mongoId}`);
          insertedIds.push({ mongoId: rec.mongoId, pgId: insertedId });
        }

        // Verify inventory row is still untouched, inside the same transaction,
        // before committing.
        await verifyTargetInventoryRow(client);

        await client.query('COMMIT');
        console.log('\n✓ Transaction committed.');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      aborted = true;
      abortReason = error.message;
      console.error('\n✗ Error during transaction -- ROLLED BACK.');
      console.error(error.message);
    } finally {
      client.release();
    }

    if (aborted) {
      console.log('\nMIGRATION ABORTED. No rows were inserted.');
      console.log(`Reason: ${abortReason}`);
      return;
    }

    // ---- Post-verification (outside the write transaction, fresh reads) ----
    console.log('\n========================================');
    console.log('POST-VERIFICATION');
    console.log('========================================');

    const afterCountRes = await pg.query('SELECT count(*)::int AS c FROM stock_ledger');
    const afterCount = afterCountRes.rows[0].c;
    const expectedAfter = EXECUTE ? beforeCount + RECORDS.length : beforeCount;
    const countOk = afterCount === expectedAfter;
    console.log(`stock_ledger count after: ${afterCount} (expected ${expectedAfter}) -- ${countOk ? 'OK' : 'MISMATCH'}`);

    if (EXECUTE && insertedIds.length === RECORDS.length) {
      for (let i = 0; i < RECORDS.length; i++) {
        const rec = RECORDS[i];
        const pgId = insertedIds[i].pgId;
        const rowRes = await pg.query('SELECT * FROM stock_ledger WHERE id = $1', [pgId]);
        const row = rowRes.rows[0];
        const checks = {
          shop_id: row.shop_id === SHOP_ID,
          item_id: row.item_id === TARGET_INVENTORY_ID,
          item_code: row.item_code === rec.itemCode,
          item_name: row.item_name === rec.itemName,
          transaction_type: row.transaction_type === rec.transactionType,
          qty_change: Math.abs(num(row.qty_change) - rec.qtyChange) < 0.001,
          gross_weight_change: Math.abs(num(row.gross_weight_change) - rec.grossWeightChange) < 0.001,
          net_weight_change: Math.abs(num(row.net_weight_change) - rec.netWeightChange) < 0.001,
          balance_qty: Math.abs(num(row.balance_qty) - rec.balanceQty) < 0.001,
          balance_gross_weight: Math.abs(num(row.balance_gross_weight) - rec.balanceGrossWeight) < 0.001,
          balance_net_weight: Math.abs(num(row.balance_net_weight) - rec.balanceNetWeight) < 0.001,
          reference_no: row.reference_no === rec.referenceNo,
          remarks: row.remarks === rec.remarks,
          date: row.date.toISOString().slice(0, 10) === rec.date
        };
        console.log(`\nInserted row [${pgId}] (mongo _id=${rec.mongoId}) exact-value check:`);
        for (const [field, ok] of Object.entries(checks)) {
          console.log(`  ${field}: ${ok ? 'OK' : 'MISMATCH'}`);
        }
        const allOk = Object.values(checks).every(Boolean);
        console.log(`  All fields correct: ${allOk ? 'YES' : 'NO'}`);
      }

      // Chain check across the 2 inserted rows, ordered by created_at.
      const chainRes = await pg.query(
        `SELECT id, qty_change, gross_weight_change, net_weight_change,
                balance_qty, balance_gross_weight, balance_net_weight, created_at
         FROM stock_ledger WHERE shop_id = $1 AND item_id = $2 ORDER BY created_at ASC`,
        [SHOP_ID, TARGET_INVENTORY_ID]
      );
      console.log('\nChain check (previous balance + delta = next balance) on inserted rows:');
      let prevQ = 10, prevG = 100, prevN = 90; // back-derived opening balance, same as dry run
      chainRes.rows.forEach((r, i) => {
        const expQ = prevQ + num(r.qty_change), expG = prevG + num(r.gross_weight_change), expN = prevN + num(r.net_weight_change);
        const ok = Math.abs(expQ - num(r.balance_qty)) < 0.005 && Math.abs(expG - num(r.balance_gross_weight)) < 0.005 && Math.abs(expN - num(r.balance_net_weight)) < 0.005;
        console.log(`  [${i}] id=${r.id} prevBal(${prevQ},${prevG},${prevN}) + delta(${r.qty_change},${r.gross_weight_change},${r.net_weight_change}) = expected(${expQ},${expG},${expN}) vs balance(${r.balance_qty},${r.balance_gross_weight},${r.balance_net_weight}) => ${ok ? 'OK' : 'BREAK'}`);
        prevQ = num(r.balance_qty); prevG = num(r.balance_gross_weight); prevN = num(r.balance_net_weight);
      });
    }

    const exactCountRes = await pg.query(
      `SELECT count(*)::int AS c FROM stock_ledger WHERE shop_id = $1 AND item_id = $2`,
      [SHOP_ID, TARGET_INVENTORY_ID]
    );
    const expectedExact = EXECUTE ? 2 : 0;
    console.log(`\nRows for (shop_id, item_id): ${exactCountRes.rows[0].c} (expected exactly ${expectedExact}) -- ${exactCountRes.rows[0].c === expectedExact ? 'OK, no duplicates' : 'MISMATCH'}`);

    const invRes = await pg.query(
      `SELECT id, name, stock, gross_weight, net_weight, available_stock, updated_at FROM inventory WHERE id = $1`,
      [TARGET_INVENTORY_ID]
    );
    const invRow = invRes.rows[0];
    const invUnchanged =
      invRow.name === EXPECTED_INVENTORY.name &&
      Math.abs(num(invRow.stock) - EXPECTED_INVENTORY.stock) < 0.001 &&
      Math.abs(num(invRow.gross_weight) - EXPECTED_INVENTORY.gross_weight) < 0.001 &&
      Math.abs(num(invRow.net_weight) - EXPECTED_INVENTORY.net_weight) < 0.001;
    console.log(`\ninventory row unchanged: stock=${invRow.stock} gross_weight=${invRow.gross_weight} net_weight=${invRow.net_weight} available_stock=${invRow.available_stock} -- ${invUnchanged ? 'OK, untouched' : 'MISMATCH'}`);

    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`Mode: ${EXECUTE ? 'EXECUTED' : 'DRY RUN'}`);
    console.log(`Inserted IDs: ${JSON.stringify(insertedIds)}`);
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
