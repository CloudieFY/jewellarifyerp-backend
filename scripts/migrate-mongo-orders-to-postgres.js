/*
 * Migrate tenant `orders` (Mongo) -> `orders` (PG).
 *
 * Dedupe key: (shop_id, order_no)  [PG has UNIQUE (shop_id, order_no)].
 * Idempotent.
 *
 * Usage:  node scripts/migrate-mongo-orders-to-postgres.js
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
function boolValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
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

    let total = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);
      const shopCheck = await pg.query(`SELECT id FROM shops WHERE id = $1`, [shopId]);
      if (!shopCheck.rowCount) {
        console.log(`\n⚠ Skipping ${shop.slug}: PostgreSQL shop not found`);
        continue;
      }

      const db = mongo.useDb(shop.dbName, { useCache: false });
      const orders = await db.db
        .collection('orders')
        .find({})
        .sort({ date: 1, createdAt: 1 })
        .toArray();
      if (!orders.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${orders.length} orders`);

      for (const o of orders) {
        if (!o.orderNo) {
          console.log('  ⚠ Skipping order with no orderNo');
          continue;
        }
        const orderNo = String(o.orderNo);

        const existing = await pg.query(
          `SELECT id FROM orders WHERE shop_id = $1 AND order_no = $2 LIMIT 1`,
          [shopId, orderNo]
        );
        if (existing.rowCount) {
          console.log(`  ↻ ${orderNo} [already migrated]`);
          continue;
        }

        await pg.query(
          `INSERT INTO orders (
             order_no, date, customer_name, customer_mobile, customer_address,
             item_description, metal, purity, expected_gross_weight, expected_net_weight,
             size_length, hallmark_required, rate_lock_status, locked_gold_rate,
             old_gold_weight, old_gold_purity, old_gold_valuation, making_charge, wastage_pct,
             estimated_total_amount, fixed_price, advance_paid, karigar_id, due_date, status,
             note, sample_image_url, customer_signature, authorized_signatory,
             created_at, updated_at, shop_id
           )
           VALUES (
             $1,$2,$3,$4,$5, $6,$7,$8,$9,$10,
             $11,$12,$13,$14, $15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,$25, $26,$27,$28,$29, $30,$31,$32
           )`,
          [
            orderNo,
            toDateOnly(o.date) || new Date().toISOString().slice(0, 10),
            nullable(o.customerName) || 'Customer',
            nullable(o.customerMobile),
            nullable(o.customerAddress),
            nullable(o.itemDescription) || 'Custom order',
            nullable(o.metal) || 'Gold',
            nullable(o.purity) || '22K',
            numberValue(o.expectedGrossWeight),
            numberValue(o.expectedNetWeight),
            nullable(o.sizeLength),
            boolValue(o.hallmarkRequired, true),
            nullable(o.rateLockStatus) || 'Locked',
            numberValue(o.lockedGoldRate),
            numberValue(o.oldGoldWeight),
            nullable(o.oldGoldPurity) || '22K',
            numberValue(o.oldGoldValuation),
            numberValue(o.makingCharge),
            numberValue(o.wastagePct),
            numberValue(o.estimatedTotalAmount),
            numberValue(o.fixedPrice),
            numberValue(o.advancePaid),
            nullable(o.karigarId),
            toDateOnly(o.dueDate),
            nullable(o.status) || 'Pending',
            nullable(o.note),
            nullable(o.sampleImageUrl),
            nullable(o.customerSignature),
            nullable(o.authorizedSignatory),
            toTs(o.createdAt),
            toTs(o.updatedAt),
            shopId,
          ]
        );
        total += 1;
        console.log(`  ✓ ${orderNo}`);
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('ORDERS MIGRATION COMPLETE');
    console.log(`Orders migrated: ${total}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nORDERS MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
