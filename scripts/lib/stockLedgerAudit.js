/*
 * Shared classification engine for the stock-ledger migration.
 *
 * Both scripts/audit-stock-ledger-migration.js (read-only report) and
 * scripts/migrate-stock-ledger.js (the actual writer) import this module,
 * so the migration can never apply looser rules than the audit reported.
 *
 * Pure read logic only -- this file never writes to Mongo or PostgreSQL.
 */

const EPSILON = 0.001;
const ANOMALY_WEIGHT_THRESHOLD = 100000; // grams -- guards against corrupt-magnitude data
const VALID_TRANSACTION_TYPES = [
  'OPENING', 'PURCHASE', 'SALE', 'TRANSFER',
  'ADJUSTMENT', 'REPAIR', 'MANUFACTURING', 'RETURN'
];

/*
 * Method A (explicit mapping). Empty by default.
 * Populate only after a human has manually verified a REVIEW/UNMAPPED item
 * and wants to force `mongoItemId -> pgInventoryId` for a specific shop.
 * Key: `${pgShopId}:${mongoItemId}` -> pgInventoryId
 */
const EXPLICIT_ITEM_MAP = {
  // demo shop, "chain" (mongo _id 6a7c5c7d09dc3c8b01d71213) -> PostgreSQL
  // inventory ae7cbe2a-0428-4a6c-b89f-45e355475ed8. Confirmed manually:
  // ae7cbe2a's created_at (2026-08-12 11:43:57.634+00) matches this Mongo
  // document's createdAt to the millisecond, distinguishing it from the
  // other same-named PostgreSQL candidate (643e9586...), which belongs to
  // a separate, later-created Mongo item. Migrated via
  // scripts/migrate-demo-chain-manual.js.
  '6a718b3b4dc2277b0539b1e0:6a7c5c7d09dc3c8b01d71213': 'ae7cbe2a-0428-4a6c-b89f-45e355475ed8'
};

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isObjectIdLike(str) {
  return typeof str === 'string' && /^[a-f0-9]{24}$/i.test(str);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function closeEnough(a, b) {
  return Math.abs(num(a) - num(b)) <= EPSILON;
}

function toDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toTimestamp(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function pushMulti(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function fmt3(n) {
  return num(n).toFixed(3);
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/*
 * Duplicate-detection key. Deliberately excludes `date`/`created_at`:
 * the already-migrated Jitendra rows were inserted with the migration's
 * run date, not the original Mongo `date`, so date is not a stable key.
 */
function dedupKey(shopId, itemId, txType, qty, gross, net, refNo, remarks) {
  return [
    shopId,
    itemId,
    normalizeText(txType),
    fmt3(qty),
    fmt3(gross),
    fmt3(net),
    normalizeText(refNo),
    normalizeText(remarks)
  ].join('|');
}

function buildBaseRow(mongoShop, doc) {
  return {
    _doc: doc,
    shopSlug: mongoShop.slug,
    shopId: String(mongoShop._id),
    mongoLedgerId: String(doc._id),
    mongoItemId: doc.itemId,
    itemCode: doc.itemCode,
    itemName: doc.itemName,
    referenceNo: doc.referenceNo,
    transactionType: doc.transactionType,
    qtyChange: doc.qtyChange,
    grossWeightChange: doc.grossWeightChange,
    netWeightChange: doc.netWeightChange,
    mongoBalance: {
      qty: doc.balanceQty,
      gross: doc.balanceGrossWeight,
      net: doc.balanceNetWeight
    },
    pgCandidate: null,
    pgCandidateId: null,
    matchMethod: 'none',
    confidence: 'NONE',
    status: null,
    notes: ''
  };
}

function addNote(row, text) {
  row.notes = row.notes ? `${row.notes}; ${text}` : text;
}

function tally(counts, status) {
  counts[status] = (counts[status] || 0) + 1;
  counts.total = (counts.total || 0) + 1;
}

/*
 * Classifies a single shop's ledger documents against its PostgreSQL
 * inventory + existing stock_ledger rows. Returns a shopReport.
 * `pg` must support `.query(text, params)` (a Pool or a transaction client).
 */
async function classifyShop(pg, mongoShop, pgShop, ledgerDocs) {
  const shopId = String(mongoShop._id);

  const shopReport = {
    slug: mongoShop.slug,
    dbName: mongoShop.dbName,
    shopId,
    pgShopFound: Boolean(pgShop),
    counts: { total: 0, SAFE: 0, ALREADY_MIGRATED: 0, REVIEW: 0, UNMAPPED: 0, ANOMALY: 0 },
    rows: []
  };

  if (!ledgerDocs.length) return shopReport;

  if (!pgShop) {
    for (const doc of ledgerDocs) {
      const row = buildBaseRow(mongoShop, doc);
      row.status = 'UNMAPPED';
      row.confidence = 'NONE';
      addNote(row, 'PostgreSQL shop not found for this Mongo shop id');
      shopReport.rows.push(row);
      tally(shopReport.counts, row.status);
    }
    return shopReport;
  }

  const invRes = await pg.query(
    `SELECT id, name, item_code, barcode, stock, gross_weight, net_weight
     FROM inventory WHERE shop_id = $1`,
    [shopId]
  );
  const inventory = invRes.rows;

  const byItemCode = new Map();
  const byBarcode = new Map();
  const byName = new Map();

  for (const inv of inventory) {
    if (inv.item_code) pushMulti(byItemCode, inv.item_code, inv);
    if (inv.barcode) pushMulti(byBarcode, inv.barcode, inv);
    pushMulti(byName, normalizeName(inv.name), inv);
  }

  const existingRes = await pg.query(
    `SELECT item_id, transaction_type, qty_change, gross_weight_change,
            net_weight_change, reference_no, remarks
     FROM stock_ledger WHERE shop_id = $1`,
    [shopId]
  );
  const existingSet = new Set(
    existingRes.rows.map(r => dedupKey(
      shopId, r.item_id, r.transaction_type,
      r.qty_change, r.gross_weight_change, r.net_weight_change,
      r.reference_no, r.remarks
    ))
  );

  const matchedRows = [];
  const candidateIdToMongoItemIds = new Map();

  // Pass 1: matching (explicit map -> item_code -> barcode -> name)
  for (const doc of ledgerDocs) {
    const row = buildBaseRow(mongoShop, doc);
    const explicitKey = `${shopId}:${doc.itemId}`;

    let candidates = [];
    let method = 'none';

    if (EXPLICIT_ITEM_MAP[explicitKey]) {
      const found = inventory.find(i => i.id === EXPLICIT_ITEM_MAP[explicitKey]);
      if (found) {
        candidates = [found];
        method = 'explicit_mapping';
      }
    }

    if (!candidates.length && doc.itemCode && !isObjectIdLike(doc.itemCode) && byItemCode.has(doc.itemCode)) {
      candidates = byItemCode.get(doc.itemCode);
      method = 'item_code';
    }

    if (!candidates.length && doc.itemCode && byBarcode.has(doc.itemCode)) {
      candidates = byBarcode.get(doc.itemCode);
      method = 'barcode';
    }

    if (!candidates.length) {
      const nn = normalizeName(doc.itemName);
      if (nn && byName.has(nn)) {
        candidates = byName.get(nn);
        method = 'name';
      }
    }

    row.matchMethod = method;

    if (!candidates.length) {
      row.status = 'UNMAPPED';
      row.confidence = 'NONE';
      row.pgCandidate = null;
    } else if (candidates.length > 1) {
      row.status = 'REVIEW';
      row.confidence = 'LOW';
      row.matchMethod = `${method}_ambiguous`;
      row.pgCandidate = `AMBIGUOUS: ${candidates.map(c => `${c.id} (${c.name})`).join(' | ')}`;
      addNote(row, `${candidates.length} PostgreSQL items matched by ${method} -- never auto-resolving an ambiguous match`);
    } else {
      const cand = candidates[0];
      row.pgCandidateId = cand.id;
      row.pgCandidate = `${cand.id} (${cand.name})`;

      if (!candidateIdToMongoItemIds.has(cand.id)) {
        candidateIdToMongoItemIds.set(cand.id, new Set());
      }
      candidateIdToMongoItemIds.get(cand.id).add(doc.itemId);
    }

    matchedRows.push(row);
  }

  // Pass 2: anomaly detection (data sanity, independent of mapping)
  for (const row of matchedRows) {
    const doc = row._doc;
    const insane =
      Math.abs(num(doc.grossWeightChange)) > ANOMALY_WEIGHT_THRESHOLD ||
      Math.abs(num(doc.netWeightChange)) > ANOMALY_WEIGHT_THRESHOLD ||
      Math.abs(num(doc.balanceGrossWeight)) > ANOMALY_WEIGHT_THRESHOLD ||
      Math.abs(num(doc.balanceNetWeight)) > ANOMALY_WEIGHT_THRESHOLD ||
      num(doc.balanceQty) < 0 ||
      num(doc.balanceGrossWeight) < 0 ||
      num(doc.balanceNetWeight) < 0;

    if (insane) {
      row.status = 'ANOMALY';
      row.confidence = 'NONE';
      addNote(row, 'Data sanity check failed: extreme-magnitude or negative weight/qty value');
    }
  }

  // Pass 3: collision detection (multiple distinct Mongo items -> same PG item)
  for (const row of matchedRows) {
    if (row.status === 'ANOMALY' || row.status === 'UNMAPPED' || row.status === 'REVIEW') continue;
    if (!row.pgCandidateId) continue;

    const ids = candidateIdToMongoItemIds.get(row.pgCandidateId);
    if (ids && ids.size > 1) {
      row.status = 'REVIEW';
      row.confidence = 'LOW';
      addNote(row, `Collision: Mongo items [${[...ids].join(', ')}] all resolve to the same PostgreSQL item ${row.pgCandidateId}`);
    }
  }

  // Pass 4: item-level reconciliation (Mongo's own final balance vs current PG inventory)
  const byMongoItem = new Map();
  for (const row of matchedRows) {
    if (!byMongoItem.has(row.mongoItemId)) byMongoItem.set(row.mongoItemId, []);
    byMongoItem.get(row.mongoItemId).push(row);
  }

  for (const [, rows] of byMongoItem) {
    const candidateIds = new Set(rows.map(r => r.pgCandidateId).filter(Boolean));
    if (candidateIds.size !== 1) continue;

    const pgCandidateId = [...candidateIds][0];
    const inv = inventory.find(i => i.id === pgCandidateId);
    if (!inv) continue;

    const sorted = [...rows].sort((a, b) => new Date(a._doc.createdAt) - new Date(b._doc.createdAt));
    const last = sorted[sorted.length - 1]._doc;

    const consistent =
      closeEnough(last.balanceQty, inv.stock) &&
      closeEnough(last.balanceGrossWeight, inv.gross_weight) &&
      closeEnough(last.balanceNetWeight, inv.net_weight);

    if (!consistent) {
      for (const row of rows) {
        if (row.status === 'ANOMALY' || row.status === 'UNMAPPED') continue;
        row.status = 'REVIEW';
        row.confidence = 'MEDIUM';
        addNote(row, `Item-level reconciliation mismatch: Mongo final balance (qty=${last.balanceQty}, gross=${last.balanceGrossWeight}, net=${last.balanceNetWeight}) vs PostgreSQL current inventory (stock=${inv.stock}, gross=${inv.gross_weight}, net=${inv.net_weight})`);
      }
    }
  }

  // Pass 5: duplicate detection (always wins) + finalize remaining rows as SAFE
  for (const row of matchedRows) {
    const doc = row._doc;

    if (row.pgCandidateId) {
      const key = dedupKey(
        shopId, row.pgCandidateId, doc.transactionType,
        doc.qtyChange, doc.grossWeightChange, doc.netWeightChange,
        doc.referenceNo, doc.remarks
      );

      if (existingSet.has(key)) {
        row.status = 'ALREADY_MIGRATED';
        row.confidence = 'HIGH';
        addNote(row, 'Matching row already exists in PostgreSQL stock_ledger (shop+item+type+qty/weight deltas+reference match)');
      }
    }

    if (!row.status) {
      if (!VALID_TRANSACTION_TYPES.includes(doc.transactionType)) {
        row.status = 'REVIEW';
        row.confidence = 'LOW';
        addNote(row, `transaction_type '${doc.transactionType}' is not in stock_ledger's allowed CHECK constraint list`);
      } else if (row.matchMethod === 'item_code' || row.matchMethod === 'barcode' || row.matchMethod === 'explicit_mapping') {
        row.status = 'SAFE';
        row.confidence = 'HIGH';
      } else if (row.matchMethod === 'name') {
        row.status = 'SAFE';
        row.confidence = 'MEDIUM';
      } else {
        row.status = 'REVIEW';
        row.confidence = 'LOW';
      }
    }

    shopReport.rows.push(row);
    tally(shopReport.counts, row.status);
  }

  return shopReport;
}

/*
 * Runs classification for every Mongo shop. `mongo` is a live mongoose
 * connection, `pg` supports `.query()`. Read-only.
 */
async function runAudit(mongo, pg) {
  const master = mongo.useDb(process.env.MASTER_DB_NAME || 'jewelshop_master', { useCache: false });

  const mongoShops = await master.db.collection('shops')
    .find({})
    .project({ _id: 1, slug: 1, dbName: 1, shopName: 1 })
    .sort({ dbName: 1 })
    .toArray();

  const pgShopsRes = await pg.query('SELECT id, slug, legacy_db_name FROM shops');
  const pgShopsById = new Map(pgShopsRes.rows.map(r => [r.id, r]));

  const shopReports = [];
  const grandTotals = { total: 0, SAFE: 0, ALREADY_MIGRATED: 0, REVIEW: 0, UNMAPPED: 0, ANOMALY: 0 };

  for (const mongoShop of mongoShops) {
    const shopId = String(mongoShop._id);
    const pgShop = pgShopsById.get(shopId);

    const db = mongo.useDb(mongoShop.dbName, { useCache: false });
    const ledgerDocs = await db.db.collection('stockledgers')
      .find({})
      .sort({ createdAt: 1 })
      .toArray();

    const shopReport = await classifyShop(pg, mongoShop, pgShop, ledgerDocs);
    shopReports.push(shopReport);

    for (const key of Object.keys(grandTotals)) {
      grandTotals[key] += shopReport.counts[key] || 0;
    }
  }

  return { shopReports, grandTotals, mongoShops, pgShopsById };
}

module.exports = {
  runAudit,
  classifyShop,
  toDateOnly,
  toTimestamp,
  num,
  VALID_TRANSACTION_TYPES
};
