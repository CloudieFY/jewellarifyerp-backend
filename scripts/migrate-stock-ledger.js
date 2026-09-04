/*
 * PHASE 6 MIGRATION (WRITER):
 * Inserts SAFE-classified Mongo `stockledgers` records into PostgreSQL
 * `stock_ledger`, using the exact same classification engine as
 * scripts/audit-stock-ledger-migration.js (scripts/lib/stockLedgerAudit.js)
 * so this script can never diverge from what the audit reported.
 *
 * Hard rules enforced by construction:
 *   - Only rows classified SAFE are ever inserted.
 *   - ALREADY_MIGRATED rows are skipped (idempotent -- see dedup logic in
 *     scripts/lib/stockLedgerAudit.js).
 *   - REVIEW / UNMAPPED / ANOMALY rows are never inserted automatically.
 *   - No UPDATE, DELETE, or TRUNCATE statements exist in this file.
 *   - No inventory table writes -- this migrates historical ledger rows
 *     only; it never touches inventory.stock/gross_weight/net_weight.
 *   - Never creates a new inventory row.
 *   - All inserts for a run happen inside a single PostgreSQL transaction.
 *
 * Safety:
 *   - Refuses to run unless the pre-migration pg_dump backup exists.
 *   - Defaults to DRY RUN (prints what it would insert, writes nothing).
 *     Pass --execute to actually commit inserts.
 *
 * Usage:
 *   node scripts/migrate-stock-ledger.js              (dry run, no writes)
 *   node scripts/migrate-stock-ledger.js --execute     (writes for real)
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');

const { runAudit, toDateOnly, toTimestamp, num } = require('./lib/stockLedgerAudit');

const EXECUTE = process.argv.includes('--execute');
const BACKUP_PATH = path.join(os.homedir(), 'jewellarify-backups', 'before-stock-ledger-migration.dump');

function assertBackupExists() {
  if (!fs.existsSync(BACKUP_PATH)) {
    throw new Error(
      `Refusing to run: backup not found at ${BACKUP_PATH}. ` +
      `Create it with pg_dump before running this migration.`
    );
  }

  const stat = fs.statSync(BACKUP_PATH);
  if (stat.size < 1024) {
    throw new Error(
      `Refusing to run: backup at ${BACKUP_PATH} is suspiciously small (${stat.size} bytes).`
    );
  }

  console.log(`✓ Backup verified: ${BACKUP_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
}

/*
 * Re-checks the dedup condition inside the live transaction right before
 * insert, in addition to the classification-time check, so two concurrent
 * runs (or a re-run mid-flight) can never double-insert the same row.
 */
async function alreadyExists(client, row, doc) {
  const res = await client.query(
    `SELECT 1 FROM stock_ledger
     WHERE shop_id = $1
       AND item_id = $2
       AND transaction_type = $3
       AND qty_change = $4
       AND gross_weight_change = $5
       AND net_weight_change = $6
       AND reference_no IS NOT DISTINCT FROM $7
       AND remarks IS NOT DISTINCT FROM $8
     LIMIT 1`,
    [
      row.shopId,
      row.pgCandidateId,
      doc.transactionType,
      num(doc.qtyChange),
      num(doc.grossWeightChange),
      num(doc.netWeightChange),
      doc.referenceNo || null,
      doc.remarks || null
    ]
  );
  return res.rowCount > 0;
}

async function insertRow(client, row) {
  const doc = row._doc;

  const res = await client.query(
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
      toDateOnly(doc.date),
      row.pgCandidateId,
      doc.itemCode || null,
      doc.itemName,
      doc.transactionType,
      num(doc.qtyChange),
      num(doc.grossWeightChange),
      num(doc.netWeightChange),
      num(doc.balanceQty),
      num(doc.balanceGrossWeight),
      num(doc.balanceNetWeight),
      doc.referenceNo || null,
      doc.remarks || null,
      row.shopId,
      toTimestamp(doc.createdAt),
      toTimestamp(doc.updatedAt)
    ]
  );

  return res.rows[0].id;
}

async function main() {
  console.log('========================================');
  console.log(`STOCK LEDGER MIGRATION -- ${EXECUTE ? 'EXECUTE MODE (writes will commit)' : 'DRY RUN (no writes)'}`);
  console.log('========================================\n');

  assertBackupExists();

  const mongo = await mongoose.createConnection(process.env.MONGODB_BASE_URI).asPromise();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  const summary = {
    inserted: 0,
    skippedAlreadyMigrated: 0,
    skippedReview: 0,
    skippedUnmapped: 0,
    skippedAnomaly: 0
  };

  try {
    console.log('Running classification (same engine as the audit script)...\n');
    const { shopReports } = await runAudit(mongo, pg);

    const client = await pg.connect();

    try {
      await client.query('BEGIN');

      for (const shopReport of shopReports) {
        if (!shopReport.rows.length) continue;

        console.log(`\n--- SHOP: ${shopReport.slug} ---`);

        for (const row of shopReport.rows) {
          const doc = row._doc;
          const label = `${row.itemName} [${row.transactionType} ${row.qtyChange}] ref=${row.referenceNo} (mongo _id=${row.mongoLedgerId})`;

          if (row.status === 'ALREADY_MIGRATED') {
            console.log(`  ↻ SKIP (ALREADY_MIGRATED): ${label}`);
            summary.skippedAlreadyMigrated++;
            continue;
          }

          if (row.status === 'REVIEW') {
            console.log(`  ⚠ SKIP (REVIEW): ${label}`);
            console.log(`      reason: ${row.notes}`);
            summary.skippedReview++;
            continue;
          }

          if (row.status === 'UNMAPPED') {
            console.log(`  ✗ SKIP (UNMAPPED): ${label}`);
            console.log(`      reason: no PostgreSQL inventory candidate found`);
            summary.skippedUnmapped++;
            continue;
          }

          if (row.status === 'ANOMALY') {
            console.log(`  ☠ SKIP (ANOMALY): ${label}`);
            console.log(`      reason: ${row.notes}`);
            summary.skippedAnomaly++;
            continue;
          }

          // row.status === 'SAFE'
          const dup = await alreadyExists(client, row, doc);
          if (dup) {
            console.log(`  ↻ SKIP (duplicate detected at insert time): ${label}`);
            summary.skippedAlreadyMigrated++;
            continue;
          }

          if (EXECUTE) {
            const insertedId = await insertRow(client, row);
            console.log(`  ✓ INSERTED [${insertedId}]: ${label} -> inventory ${row.pgCandidateId}`);
          } else {
            console.log(`  ✓ WOULD INSERT: ${label} -> inventory ${row.pgCandidateId}`);
          }
          summary.inserted++;
        }
      }

      if (EXECUTE) {
        await client.query('COMMIT');
        console.log('\n✓ Transaction committed.');
      } else {
        await client.query('ROLLBACK');
        console.log('\n(dry run -- transaction rolled back, no data was written)');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log('\n========================================');
    console.log('MIGRATION SUMMARY');
    console.log('========================================');
    console.log(`Mode:                        ${EXECUTE ? 'EXECUTED' : 'DRY RUN'}`);
    console.log(`Inserted (or would insert):  ${summary.inserted}`);
    console.log(`Skipped - ALREADY_MIGRATED:  ${summary.skippedAlreadyMigrated}`);
    console.log(`Skipped - REVIEW:            ${summary.skippedReview}`);
    console.log(`Skipped - UNMAPPED:          ${summary.skippedUnmapped}`);
    console.log(`Skipped - ANOMALY:           ${summary.skippedAnomaly}`);

    if (!EXECUTE) {
      console.log('\nThis was a dry run. Re-run with --execute to commit these inserts.');
    }
  } finally {
    await mongo.close();
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
