/*
 * PHASE 1-5 AUDIT (READ-ONLY / DRY-RUN):
 * Compares Mongo `stockledgers` (per-shop legacy DBs) against PostgreSQL
 * `stock_ledger` + `inventory`, and classifies every Mongo ledger record as
 * SAFE / ALREADY_MIGRATED / REVIEW / UNMAPPED / ANOMALY.
 *
 * This script performs NO WRITES. It only reads from Mongo and PostgreSQL
 * and prints a report + the exact INSERT statements that WOULD run for
 * SAFE records. scripts/migrate-stock-ledger.js (which imports the same
 * classification engine from scripts/lib/stockLedgerAudit.js) is the
 * actual writer.
 *
 * Run: node scripts/audit-stock-ledger-migration.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');

const { runAudit, toDateOnly, toTimestamp, num } = require('./lib/stockLedgerAudit');

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildInsertStatement(row) {
  const doc = row._doc;

  return (
    `INSERT INTO stock_ledger (` +
    `date, item_id, item_code, item_name, transaction_type, ` +
    `qty_change, gross_weight_change, net_weight_change, ` +
    `balance_qty, balance_gross_weight, balance_net_weight, ` +
    `reference_no, remarks, shop_id, created_at, updated_at` +
    `) VALUES (` +
    `${sqlStr(toDateOnly(doc.date))}, ` +
    `${sqlStr(row.pgCandidateId)}, ` +
    `${sqlStr(doc.itemCode)}, ` +
    `${sqlStr(doc.itemName)}, ` +
    `${sqlStr(doc.transactionType)}, ` +
    `${num(doc.qtyChange)}, ` +
    `${num(doc.grossWeightChange)}, ` +
    `${num(doc.netWeightChange)}, ` +
    `${num(doc.balanceQty)}, ` +
    `${num(doc.balanceGrossWeight)}, ` +
    `${num(doc.balanceNetWeight)}, ` +
    `${sqlStr(doc.referenceNo)}, ` +
    `${sqlStr(doc.remarks)}, ` +
    `${sqlStr(row.shopId)}, ` +
    `${sqlStr(toTimestamp(doc.createdAt).toISOString())}, ` +
    `${sqlStr(toTimestamp(doc.updatedAt).toISOString())}` +
    `); -- mongo stockledgers._id=${doc._id}`
  );
}

async function main() {
  const mongo = await mongoose.createConnection(process.env.MONGODB_BASE_URI).asPromise();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { shopReports, grandTotals, mongoShops } = await runAudit(mongo, pg);
    console.log(`Discovered ${mongoShops.length} Mongo shops.`);

    const insertStatements = [];
    for (const shopReport of shopReports) {
      for (const row of shopReport.rows) {
        if (row.status === 'SAFE') {
          insertStatements.push(buildInsertStatement(row));
        }
      }
    }

    printReport(shopReports, grandTotals, insertStatements);
    writeArtifacts(shopReports, grandTotals, insertStatements);
  } finally {
    await mongo.close();
    await pg.end();
  }
}

function printReport(shopReports, grandTotals, insertStatements) {
  console.log('\n========================================');
  console.log('STOCK LEDGER MIGRATION AUDIT (DRY RUN)');
  console.log('========================================');

  for (const shopReport of shopReports) {
    console.log('\n----------------------------------------');
    console.log(`SHOP: ${shopReport.slug} (mongo db: ${shopReport.dbName})`);
    console.log('----------------------------------------');

    if (!shopReport.pgShopFound) {
      console.log('⚠ PostgreSQL shop NOT FOUND -- all records UNMAPPED');
    }

    if (!shopReport.rows.length) {
      console.log('(no stockledgers documents for this shop)');
      continue;
    }

    for (const row of shopReport.rows) {
      console.log('');
      console.log(`  [${row.status}] mongo ledger _id=${row.mongoLedgerId}`);
      console.log(`    shop            : ${row.shopSlug}`);
      console.log(`    mongo itemId    : ${row.mongoItemId}`);
      console.log(`    itemCode        : ${row.itemCode}`);
      console.log(`    itemName        : ${row.itemName}`);
      console.log(`    referenceNo     : ${row.referenceNo}`);
      console.log(`    transactionType : ${row.transactionType}`);
      console.log(`    qtyChange       : ${row.qtyChange}`);
      console.log(`    grossWeightChg  : ${row.grossWeightChange}`);
      console.log(`    netWeightChg    : ${row.netWeightChange}`);
      console.log(`    mongoBalance    : qty=${row.mongoBalance.qty} gross=${row.mongoBalance.gross} net=${row.mongoBalance.net}`);
      console.log(`    pgCandidate     : ${row.pgCandidate || '(none)'}`);
      console.log(`    matchMethod     : ${row.matchMethod}`);
      console.log(`    confidence      : ${row.confidence}`);
      if (row.notes) console.log(`    notes           : ${row.notes}`);
    }

    console.log('');
    console.log(`  SAFE:            ${shopReport.counts.SAFE || 0}`);
    console.log(`  ALREADY_MIGRATED:${shopReport.counts.ALREADY_MIGRATED || 0}`);
    console.log(`  REVIEW:          ${shopReport.counts.REVIEW || 0}`);
    console.log(`  UNMAPPED:        ${shopReport.counts.UNMAPPED || 0}`);
    console.log(`  ANOMALY:         ${shopReport.counts.ANOMALY || 0}`);
  }

  console.log('\n========================================');
  console.log('TOTALS');
  console.log('========================================');
  console.log(`TOTAL RECORDS:    ${grandTotals.total}`);
  console.log(`SAFE:             ${grandTotals.SAFE}`);
  console.log(`ALREADY_MIGRATED: ${grandTotals.ALREADY_MIGRATED}`);
  console.log(`REVIEW:           ${grandTotals.REVIEW}`);
  console.log(`UNMAPPED:         ${grandTotals.UNMAPPED}`);
  console.log(`ANOMALY:          ${grandTotals.ANOMALY}`);

  console.log('\n========================================');
  console.log(`PROPOSED INSERT STATEMENTS FOR SAFE RECORDS (${insertStatements.length}) -- NOT EXECUTED`);
  console.log('========================================');
  if (!insertStatements.length) {
    console.log('(none)');
  } else {
    for (const stmt of insertStatements) {
      console.log(stmt);
    }
  }
}

function writeArtifacts(shopReports, grandTotals, insertStatements) {
  const jsonPath = path.join(__dirname, 'audit-stock-ledger-report.json');
  const sqlPath = path.join(__dirname, 'audit-stock-ledger-safe-inserts.sql');

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    totals: grandTotals,
    shops: shopReports.map(s => ({
      slug: s.slug,
      dbName: s.dbName,
      shopId: s.shopId,
      pgShopFound: s.pgShopFound,
      counts: s.counts,
      rows: s.rows.map(r => ({
        mongoLedgerId: r.mongoLedgerId,
        shopSlug: r.shopSlug,
        mongoItemId: r.mongoItemId,
        itemCode: r.itemCode,
        itemName: r.itemName,
        referenceNo: r.referenceNo,
        transactionType: r.transactionType,
        qtyChange: r.qtyChange,
        grossWeightChange: r.grossWeightChange,
        netWeightChange: r.netWeightChange,
        mongoBalance: r.mongoBalance,
        pgCandidate: r.pgCandidate,
        pgCandidateId: r.pgCandidateId,
        matchMethod: r.matchMethod,
        confidence: r.confidence,
        status: r.status,
        notes: r.notes
      }))
    }))
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  fs.writeFileSync(sqlPath, insertStatements.join('\n\n') + '\n');

  console.log(`\nFull JSON report written to: ${jsonPath}`);
  console.log(`SAFE insert statements written to: ${sqlPath}`);
}

main().catch((error) => {
  console.error('\n========================================');
  console.error('AUDIT FAILED');
  console.error('========================================');
  console.error(error);
  process.exitCode = 1;
});
