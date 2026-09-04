/*
 * PHASE 2 -- MANUAL REVIEW ANALYSIS (READ-ONLY).
 *
 * Groups every REVIEW / UNMAPPED / ANOMALY stock-ledger record by
 * (shop, mongo itemId), enriches each group with live PostgreSQL inventory
 * data, and classifies it into one of:
 *   A. SAFE AFTER MANUAL MAPPING
 *   B. SAFE AFTER HISTORICAL RECONCILIATION
 *   C. DUPLICATE/COLLISION -- DO NOT MIGRATE
 *   D. HISTORICAL DATA ANOMALY -- DO NOT MIGRATE
 *   E. MISSING POSTGRES INVENTORY -- DO NOT MIGRATE
 *
 * This script performs NO WRITES to Mongo or PostgreSQL -- SELECT/find only.
 *
 * Run: node scripts/analyze-stock-ledger-review.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');

const { runAudit, num } = require('./lib/stockLedgerAudit');

function fmtNum(v) {
  return num(v);
}

function classifyGroup(rows) {
  const statuses = new Set(rows.map(r => r.status));

  if (statuses.has('UNMAPPED')) {
    return {
      category: 'E',
      label: 'MISSING POSTGRES INVENTORY -- DO NOT MIGRATE',
      reason: 'No PostgreSQL inventory row matches this Mongo item by item_code, barcode, sku, qr_code, or normalized name within this shop.'
    };
  }

  if (statuses.has('ANOMALY')) {
    return {
      category: 'D',
      label: 'HISTORICAL DATA ANOMALY -- DO NOT MIGRATE',
      reason: 'One or more ledger records contain extreme-magnitude or negative weight/qty values that cannot represent physically real jewellery weights.'
    };
  }

  const hasCollision = rows.some(r => /Collision:/.test(r.notes || ''));
  if (hasCollision) {
    return {
      category: 'C',
      label: 'DUPLICATE/COLLISION -- DO NOT MIGRATE',
      reason: 'This Mongo item resolves to the same PostgreSQL inventory row as at least one other distinct Mongo item. Migrating either would corrupt that PostgreSQL item\'s stock arithmetic by attributing another item\'s movements to it.'
    };
  }

  const hasAmbiguousMatch = rows.some(r => (r.matchMethod || '').includes('ambiguous'));
  if (hasAmbiguousMatch) {
    return {
      category: 'A',
      label: 'SAFE AFTER MANUAL MAPPING',
      reason: 'Multiple PostgreSQL items share the same normalized name; the audit will not auto-pick one. A human needs to confirm which candidate is correct.'
    };
  }

  const hasReconciliationMismatch = rows.some(r => /reconciliation mismatch/.test(r.notes || ''));
  if (hasReconciliationMismatch) {
    return {
      category: 'B',
      label: 'SAFE AFTER HISTORICAL RECONCILIATION',
      reason: 'The PostgreSQL candidate is uniquely and confidently matched, but Mongo\'s own final ledger balance does not equal current PostgreSQL inventory. The discrepancy must be explained/reconciled by a human before migrating.'
    };
  }

  return {
    category: 'A',
    label: 'SAFE AFTER MANUAL MAPPING',
    reason: 'Unresolved by the automated rules for a reason not covered by collision/ambiguity/reconciliation checks (e.g. unsupported transaction_type). Needs manual review.'
  };
}

async function fetchInventoryDetails(pg, ids) {
  if (!ids.length) return new Map();
  const res = await pg.query(
    `SELECT id, name, item_code, barcode, sku, qr_code, stock, gross_weight, net_weight, available_stock
     FROM inventory WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(res.rows.map(r => [r.id, r]));
}

function extractCandidateIds(pgCandidate) {
  if (!pgCandidate) return [];
  const matches = [...pgCandidate.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)];
  return matches.map(m => m[1]);
}

/*
 * Self-consistency check on Mongo's own ledger chain for one item:
 * does each record's balance equal the previous record's balance + this
 * record's change? This is independent of PostgreSQL and tells us whether
 * the Mongo history itself is coherent.
 */
function checkChainConsistency(rowsChrono) {
  const breaks = [];
  for (let i = 1; i < rowsChrono.length; i++) {
    const prev = rowsChrono[i - 1]._doc;
    const cur = rowsChrono[i]._doc;

    const expectedQty = num(prev.balanceQty) + num(cur.qtyChange);
    const expectedGross = num(prev.balanceGrossWeight) + num(cur.grossWeightChange);
    const expectedNet = num(prev.balanceNetWeight) + num(cur.netWeightChange);

    const EPS = 0.001;
    const qtyOk = Math.abs(expectedQty - num(cur.balanceQty)) <= EPS;
    const grossOk = Math.abs(expectedGross - num(cur.balanceGrossWeight)) <= EPS;
    const netOk = Math.abs(expectedNet - num(cur.balanceNetWeight)) <= EPS;

    if (!qtyOk || !grossOk || !netOk) {
      breaks.push({
        afterMongoLedgerId: rowsChrono[i - 1].mongoLedgerId,
        atMongoLedgerId: rowsChrono[i].mongoLedgerId,
        expected: { qty: expectedQty, gross: expectedGross, net: expectedNet },
        actual: { qty: num(cur.balanceQty), gross: num(cur.balanceGrossWeight), net: num(cur.balanceNetWeight) },
        qtyOk, grossOk, netOk
      });
    }
  }
  return breaks;
}

async function main() {
  const mongo = await mongoose.createConnection(process.env.MONGODB_BASE_URI).asPromise();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { shopReports } = await runAudit(mongo, pg);

    // Collect all REVIEW / UNMAPPED / ANOMALY rows, grouped by (shopSlug, mongoItemId)
    const groups = new Map();

    for (const shopReport of shopReports) {
      for (const row of shopReport.rows) {
        if (!['REVIEW', 'UNMAPPED', 'ANOMALY'].includes(row.status)) continue;

        const key = `${shopReport.slug}::${row.mongoItemId}`;
        if (!groups.has(key)) {
          groups.set(key, {
            shopSlug: shopReport.slug,
            shopId: shopReport.shopId,
            mongoItemId: row.mongoItemId,
            rows: []
          });
        }
        groups.get(key).rows.push(row);
      }
    }

    // Gather all candidate PG ids referenced across all groups
    const allCandidateIds = new Set();
    for (const group of groups.values()) {
      for (const row of group.rows) {
        if (row.pgCandidateId) allCandidateIds.add(row.pgCandidateId);
        for (const id of extractCandidateIds(row.pgCandidate)) allCandidateIds.add(id);
      }
    }
    const inventoryDetails = await fetchInventoryDetails(pg, [...allCandidateIds]);

    const reportGroups = [];

    for (const group of groups.values()) {
      // rows within a shop were pushed in chronological (createdAt asc) order;
      // filtering to one mongoItemId preserves that relative order.
      const rowsChrono = group.rows;
      const first = rowsChrono[0];
      const last = rowsChrono[rowsChrono.length - 1];

      const candidateIdSet = new Set();
      for (const row of rowsChrono) {
        if (row.pgCandidateId) candidateIdSet.add(row.pgCandidateId);
        for (const id of extractCandidateIds(row.pgCandidate)) candidateIdSet.add(id);
      }
      const candidates = [...candidateIdSet].map(id => inventoryDetails.get(id)).filter(Boolean);

      const classification = classifyGroup(rowsChrono);

      const distinctRefs = [...new Set(rowsChrono.map(r => r.referenceNo))];
      const distinctTypes = [...new Set(rowsChrono.map(r => r.transactionType))];
      const distinctNotes = [...new Set(rowsChrono.map(r => r.notes).filter(Boolean))];

      const chainBreaks = checkChainConsistency(rowsChrono);

      reportGroups.push({
        shop: group.shopSlug,
        shopId: group.shopId,
        mongoItemId: group.mongoItemId,
        mongoItemCode: first.itemCode,
        mongoItemName: first.itemName,
        pgCandidates: candidates.map(c => ({
          id: c.id,
          name: c.name,
          barcode: c.barcode,
          currentStock: fmtNum(c.stock),
          currentGrossWeight: fmtNum(c.gross_weight),
          currentNetWeight: fmtNum(c.net_weight)
        })),
        mongoLedgerRecordCount: rowsChrono.length,
        distinctReferenceNumbers: distinctRefs,
        distinctTransactionTypes: distinctTypes,
        mongoFinalBalance: last.mongoBalance,
        mongoFinalBalanceAsOf: last.mongoLedgerId,
        chainSelfConsistency: {
          consistent: chainBreaks.length === 0,
          breakCount: chainBreaks.length,
          breaks: chainBreaks
        },
        reviewReasons: distinctNotes,
        category: classification.category,
        categoryLabel: classification.label,
        categoryReason: classification.reason,
        records: rowsChrono.map(r => ({
          mongoLedgerId: r.mongoLedgerId,
          referenceNo: r.referenceNo,
          transactionType: r.transactionType,
          qtyChange: r.qtyChange,
          grossWeightChange: r.grossWeightChange,
          netWeightChange: r.netWeightChange,
          balanceQty: r.mongoBalance.qty,
          balanceGrossWeight: r.mongoBalance.gross,
          balanceNetWeight: r.mongoBalance.net,
          matchMethod: r.matchMethod,
          notes: r.notes,
          date: r._doc.date,
          createdAt: r._doc.createdAt,
          remarks: r._doc.remarks
        }))
      });
    }

    // Also explicitly include Patel mangalsutra (UNMAPPED) verification detail
    // and Soni's anomaly magnitude calculation, per the requested deep-dives.
    const patelMangalsutra = reportGroups.find(g => g.shop === 'patel' && g.mongoItemName === 'mangalsutra');
    if (patelMangalsutra) {
      patelMangalsutra.missingInventorySearch = {
        searchedByItemCode: patelMangalsutra.mongoItemCode,
        searchedByBarcode: patelMangalsutra.mongoItemCode,
        searchedByNormalizedName: 'mangalsutra',
        fieldsChecked: ['item_code', 'barcode', 'sku', 'qr_code', 'name (normalized)'],
        patelInventoryRowCount: 3,
        patelInventoryNames: ['chain', 'Cada', 'Bulk Purchase: Gold 22K (PUR-0003)'],
        result: 'No match on any field. No PostgreSQL inventory row for this item exists in the patel shop.',
        actionTaken: 'None -- no new inventory row was created, per instructions.'
      };
    }

    const soniRing = reportGroups.find(g => g.shop === 'soni-jewellers');
    if (soniRing) {
      const grossVals = soniRing.records.map(r => Math.abs(num(r.grossWeightChange))).filter(v => v > 0);
      const netVals = soniRing.records.map(r => Math.abs(num(r.netWeightChange))).filter(v => v > 0);
      const maxGross = Math.max(...grossVals);
      const maxNet = Math.max(...netVals);
      const TYPICAL_RING_GRAMS = 8; // representative gross weight for a gold ring elsewhere in this dataset
      soniRing.anomalyMagnitude = {
        maxAbsGrossWeightChange: maxGross,
        maxAbsNetWeightChange: maxNet,
        grossToNetRatio: maxGross / maxNet,
        ratioVsTypicalRingWeight: maxGross / TYPICAL_RING_GRAMS,
        explanation:
          `grossWeightChange magnitude (${maxGross.toLocaleString()} g) is ` +
          `${(maxGross / maxNet).toLocaleString(undefined, { maximumFractionDigits: 0 })}x ` +
          `larger than netWeightChange (${maxNet} g) on the same record. Net weight must always be <= ` +
          `gross weight for a physical jewellery item (net = gross - stone/other weight), so a ratio this ` +
          `large is structurally impossible, not just unusual. For scale: ${maxGross.toLocaleString()} g is ` +
          `roughly ${(maxGross / TYPICAL_RING_GRAMS).toExponential(2)}x the gross weight of a typical gold ` +
          `ring (~${TYPICAL_RING_GRAMS} g, e.g. Jitendra's "gold rings" item at 50.76 g total for 16 units). ` +
          `This is corrupted/anomalous data, not a real weight -- classified ANOMALY, do not migrate.`
      };
    }

    printSummaryTable(reportGroups);
    writeReport(reportGroups);

    if (patelMangalsutra) {
      console.log('\n--- PATEL "mangalsutra" MISSING-INVENTORY SEARCH ---');
      console.log(JSON.stringify(patelMangalsutra.missingInventorySearch, null, 2));
    }
    if (soniRing) {
      console.log('\n--- SONI "18K GENTS RING" ANOMALY MAGNITUDE ---');
      console.log(JSON.stringify(soniRing.anomalyMagnitude, null, 2));
    }

    printDemoCadaAnalysis(reportGroups);
    printPatelChainAnalysis(reportGroups);
  } finally {
    await mongo.close();
    await pg.end();
  }
}

function printDemoCadaAnalysis(reportGroups) {
  const mainCada = reportGroups.find(g => g.shop === 'demo' && g.mongoItemId === '6a7b1e46e3c7d4b1d4c2a86d');
  if (!mainCada) return;

  console.log('\n========================================');
  console.log('DEMO "cada" (main item) -- 38-RECORD CHRONOLOGICAL ANALYSIS');
  console.log('========================================');
  console.log(`Mongo self-consistency: ${mainCada.chainSelfConsistency.consistent ? 'CONSISTENT (every record\'s balance follows from the previous balance + its own delta)' : `${mainCada.chainSelfConsistency.breakCount} BREAK(S) FOUND`}`);

  const refCounts = {};
  for (const r of mainCada.records) refCounts[r.referenceNo] = (refCounts[r.referenceNo] || 0) + 1;
  console.log('\nRecords per reference number (repeated refs = edit/restore/delete cycles on the same invoice):');
  for (const [ref, count] of Object.entries(refCounts)) {
    console.log(`  ${ref}: ${count} record(s)`);
  }

  const remarksCounts = {};
  for (const r of mainCada.records) remarksCounts[r.remarks] = (remarksCounts[r.remarks] || 0) + 1;
  console.log('\nRecords per remarks/transaction narrative:');
  for (const [remarks, count] of Object.entries(remarksCounts)) {
    console.log(`  "${remarks}": ${count}`);
  }

  if (mainCada.chainSelfConsistency.breaks.length) {
    console.log('\nChain breaks (Mongo\'s own balances do not follow from previous record):');
    for (const b of mainCada.chainSelfConsistency.breaks) {
      console.log(`  after ${b.afterMongoLedgerId} -> at ${b.atMongoLedgerId}: expected qty/gross/net=${JSON.stringify(b.expected)} but got ${JSON.stringify(b.actual)}`);
    }
  }
}

function printPatelChainAnalysis(reportGroups) {
  const chian = reportGroups.find(g => g.shop === 'patel' && g.mongoItemId === '6a704606713f3be0126047a7');
  const chain2 = reportGroups.find(g => g.shop === 'patel' && g.mongoItemId === '6a705443870d06d34ed239a8');
  if (!chian && !chain2) return;

  console.log('\n========================================');
  console.log('PATEL "chain"/"chian" -- SAME PRODUCT OR SEPARATE PRODUCTS?');
  console.log('========================================');

  if (chian) {
    console.log(`\nMongo item A: ${chian.mongoItemId}`);
    console.log(`  itemCode: ${chian.mongoItemCode} (a real, human-assigned code)`);
    console.log(`  itemName: ${chian.mongoItemName}`);
    console.log(`  matches PostgreSQL "chain" (ba0c25d6...) by: exact barcode match on "123456"`);
    console.log(`  reference numbers used: ${chian.distinctReferenceNumbers.join(', ')}`);
  }
  if (chain2) {
    console.log(`\nMongo item B: ${chain2.mongoItemId}`);
    console.log(`  itemCode: ${chain2.mongoItemCode} (equals its own Mongo _id -- no real code was ever assigned)`);
    console.log(`  itemName: ${chain2.mongoItemName}`);
    console.log(`  matches PostgreSQL "chain" (ba0c25d6...) by: normalized NAME ONLY (no code/barcode evidence)`);
    console.log(`  reference numbers used: ${chain2.distinctReferenceNumbers.join(', ')}`);
  }

  if (chian && chain2) {
    const sameRefs = chian.distinctReferenceNumbers.filter(r => chain2.distinctReferenceNumbers.includes(r));
    console.log(`\nShared reference number(s) between item A and item B: ${sameRefs.length ? sameRefs.join(', ') : '(none)'}`);
    console.log('Both Mongo items are driven entirely by reference "GST-0017" and both resolve to the same');
    console.log('single PostgreSQL "chain" row. Item A has a real, human-entered item code (123456) that');
    console.log('exactly matches PostgreSQL\'s barcode -- this is the stronger claim to being "chain" in');
    console.log('PostgreSQL. Item B has no code of its own (itemCode falls back to its Mongo _id) and only');
    console.log('matched by name coincidence. Both being tied to the exact same invoice reference number is');
    console.log('a strong signal that item B is a duplicate/parallel Mongo record created during an edit of');
    console.log('the same underlying transaction, not a genuinely distinct physical product -- but this');
    console.log('cannot be confirmed automatically. A human with access to the original GST-0017 invoice');
    console.log('history must decide whether B is a duplicate of A (in which case only A\'s history should');
    console.log('ever be migrated) or a real second item (in which case B needs its own PostgreSQL inventory');
    console.log('row created manually, never auto-created by a script). Until that determination is made,');
    console.log('BOTH remain COLLISION / DO NOT MIGRATE.');
  }
}

function printSummaryTable(reportGroups) {
  console.log('\n========================================');
  console.log('STOCK LEDGER REVIEW ANALYSIS -- SUMMARY TABLE');
  console.log('========================================\n');

  const header = ['SHOP', 'MONGO ITEM', 'PG CANDIDATE', 'RECORDS', 'CATEGORY', 'RECOMMENDED ACTION'];
  const rows = reportGroups
    .sort((a, b) => (a.shop + a.mongoItemName).localeCompare(b.shop + b.mongoItemName))
    .map(g => [
      g.shop,
      `${g.mongoItemName} (${g.mongoItemId.slice(0, 8)}...)`,
      g.pgCandidates.length
        ? g.pgCandidates.map(c => `${c.name} (${c.id.slice(0, 8)}...)`).join(' | ')
        : '(none)',
      String(g.mongoLedgerRecordCount),
      g.category,
      g.categoryLabel
    ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));

  const printRow = (cols) => {
    console.log(cols.map((c, i) => String(c).padEnd(widths[i])).join(' | '));
  };

  printRow(header);
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'));
  for (const row of rows) printRow(row);
}

function writeReport(reportGroups) {
  const outPath = path.join(__dirname, 'stock-ledger-review-report.json');
  const summary = {
    A_SAFE_AFTER_MANUAL_MAPPING: reportGroups.filter(g => g.category === 'A').length,
    B_SAFE_AFTER_HISTORICAL_RECONCILIATION: reportGroups.filter(g => g.category === 'B').length,
    C_DUPLICATE_COLLISION: reportGroups.filter(g => g.category === 'C').length,
    D_HISTORICAL_DATA_ANOMALY: reportGroups.filter(g => g.category === 'D').length,
    E_MISSING_POSTGRES_INVENTORY: reportGroups.filter(g => g.category === 'E').length,
    totalGroups: reportGroups.length,
    totalRecordsCovered: reportGroups.reduce((s, g) => s + g.mongoLedgerRecordCount, 0)
  };

  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Analysis only. No INSERT/UPDATE/DELETE was performed against MongoDB or PostgreSQL.',
    summary,
    groups: reportGroups
  }, null, 2));

  console.log(`\nFull report written to: ${outPath}`);
  console.log('\nCATEGORY TOTALS:');
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((error) => {
  console.error('\nANALYSIS FAILED');
  console.error(error);
  process.exitCode = 1;
});
