/*
 * Migrate the tenant `girvis` collection (Mongo) -> `girvi` + `girvi_items` (PG).
 *
 * The Mongo doc keeps BOTH a flat single-item shape (itemType, grossWeight, …)
 * AND an optional `items[]` array. The flat fields map to columns on `girvi`;
 * the array maps to the `girvi_items` child table.
 *
 * Dedupe key: (shop_id, loan_no). Idempotent.
 * Usage:  node scripts/migrate-mongo-girvi-to-postgres.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toTs(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function nullable(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}
function numberValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

async function migrateGirviItems(pg, girviId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const existing = await pg.query(`SELECT 1 FROM girvi_items WHERE girvi_id = $1 LIMIT 1`, [girviId]);
  if (existing.rowCount) return 0;

  let n = 0;
  for (const it of items) {
    await pg.query(
      `INSERT INTO girvi_items
        (girvi_id, item_type, item_category, item_description,
         gross_weight, net_weight, purity, market_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        girviId,
        nullable(it.itemType) || 'Gold',
        nullable(it.itemCategory),
        nullable(it.itemDescription) || 'Pledged item',
        numberValue(it.grossWeight),
        numberValue(it.netWeight),
        nullable(it.purity) || '22K',
        it.marketValue === undefined ? null : numberValue(it.marketValue),
      ]
    );
    n += 1;
  }
  return n;
}

async function main() {
  const mongo = await mongoose.createConnection(process.env.MONGODB_BASE_URI).asPromise();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const master = mongo.useDb(process.env.MASTER_DB_NAME || 'jewelshop_master', { useCache: false });
    const shops = await master.db
      .collection('shops')
      .find({})
      .project({ _id: 1, slug: 1, dbName: 1 })
      .sort({ dbName: 1 })
      .toArray();

    console.log(`Found ${shops.length} Mongo shops.`);
    await pg.query('BEGIN');

    let totalGirvi = 0;
    let totalItems = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);
      const shopCheck = await pg.query(`SELECT id FROM shops WHERE id = $1`, [shopId]);
      if (!shopCheck.rowCount) {
        console.log(`\n⚠ Skipping ${shop.slug}: PostgreSQL shop not found`);
        continue;
      }

      const db = mongo.useDb(shop.dbName, { useCache: false });
      const records = await db.db
        .collection('girvis')
        .find({})
        .sort({ date: 1, createdAt: 1 })
        .toArray();
      if (!records.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${records.length} girvi records`);

      for (const g of records) {
        if (!g.loanNo) {
          console.log('  ⚠ Skipping girvi with no loanNo');
          continue;
        }
        const loanNo = String(g.loanNo);

        const existing = await pg.query(
          `SELECT id FROM girvi WHERE shop_id = $1 AND loan_no = $2 LIMIT 1`,
          [shopId, loanNo]
        );

        let girviId;
        if (existing.rowCount) {
          girviId = existing.rows[0].id;
          const backfilled = await migrateGirviItems(pg, girviId, g.items);
          totalItems += backfilled;
          console.log(`  ↻ ${loanNo} [already migrated]${backfilled ? ` (+${backfilled} items)` : ''}`);
          continue;
        }

        const res = await pg.query(
          `INSERT INTO girvi (
             date, loan_no, customer_name, customer_mobile, customer_mobile2, customer_address,
             item_type, item_category, item_description, gross_weight, net_weight, purity, market_value,
             loan_amount, interest_pct, document_type, document_number, image_url, due_date, status,
             forwarded_to, forwarded_shop_name, forwarded_shop_gst_no, forwarded_shop_address,
             forwarded_date, forwarded_amount, forwarded_interest_pct, is_forwarded_settled,
             forwarded_settled_date, forwarded_settled_interest, forwarded_image_url,
             customer_signature, authorized_signatory, note, created_at, updated_at, shop_id
           )
           VALUES (
             $1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24, $25,$26,$27,$28, $29,$30,$31,
             $32,$33,$34,$35,$36,$37
           )
           RETURNING id`,
          [
            toDateOnly(g.date) || new Date().toISOString().slice(0, 10),
            loanNo,
            nullable(g.customerName) || 'Customer',
            nullable(g.customerMobile),
            nullable(g.customerMobile2),
            nullable(g.customerAddress),
            nullable(g.itemType),
            nullable(g.itemCategory),
            nullable(g.itemDescription),
            g.grossWeight === undefined ? null : numberValue(g.grossWeight),
            g.netWeight === undefined ? null : numberValue(g.netWeight),
            nullable(g.purity),
            g.marketValue === undefined ? null : numberValue(g.marketValue),
            numberValue(g.loanAmount),
            numberValue(g.interestPct),
            nullable(g.documentType),
            nullable(g.documentNumber),
            nullable(g.imageUrl),
            toDateOnly(g.dueDate),
            nullable(g.status) || 'Active',
            nullable(g.forwardedTo),
            nullable(g.forwardedShopName),
            nullable(g.forwardedShopGstNo),
            nullable(g.forwardedShopAddress),
            toDateOnly(g.forwardedDate),
            g.forwardedAmount === undefined ? null : numberValue(g.forwardedAmount),
            g.forwardedInterestPct === undefined ? null : numberValue(g.forwardedInterestPct),
            boolValue(g.isForwardedSettled, false),
            toDateOnly(g.forwardedSettledDate),
            g.forwardedSettledInterest === undefined ? null : numberValue(g.forwardedSettledInterest),
            nullable(g.forwardedImageUrl),
            nullable(g.customerSignature),
            nullable(g.authorizedSignatory),
            nullable(g.note),
            toTs(g.createdAt),
            toTs(g.updatedAt),
            shopId,
          ]
        );
        girviId = res.rows[0].id;
        const n = await migrateGirviItems(pg, girviId, g.items);
        totalItems += n;
        totalGirvi += 1;
        console.log(`  ✓ ${loanNo} [${girviId}]${n ? ` (${n} items)` : ''}`);
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('GIRVI MIGRATION COMPLETE');
    console.log(`Girvi records migrated: ${totalGirvi}`);
    console.log(`Pledged items migrated: ${totalItems}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nGIRVI MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
