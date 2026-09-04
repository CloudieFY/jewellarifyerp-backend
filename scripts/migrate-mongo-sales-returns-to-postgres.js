/*
 * Migrate the tenant `salesreturns` collection (Mongo) ->
 * `sales_returns` + `sales_return_items` (PG).
 *
 * The Mongo doc embeds an `items[]` array which becomes the
 * `sales_return_items` child table.
 *
 * Dedupe key: (shop_id, return_no). Idempotent.
 *
 * NOTE: this migrates the RECORD only. It deliberately does NOT re-run the
 * inventory-restore / dues-adjustment side effects that the live
 * POST /api/sales-returns performs — those were already applied when the
 * return was originally created in Mongo, and the invoice / inventory rows
 * carry their post-return state through their own migrations.
 *
 * Usage:  node scripts/migrate-mongo-sales-returns-to-postgres.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toTs(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
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
function safeRefundMode(v) {
  const allowed = ['Cash', 'UPI', 'Card', 'Adjust Dues', 'Store Credit'];
  return allowed.includes(v) ? v : 'Cash';
}

async function migrateReturnItems(pg, returnId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const existing = await pg.query(
    `SELECT 1 FROM sales_return_items WHERE sales_return_id = $1 LIMIT 1`,
    [returnId]
  );
  if (existing.rowCount) return 0;

  let n = 0;
  for (const it of items) {
    await pg.query(
      `INSERT INTO sales_return_items
        (sales_return_id, product_id, name, purity, net_weight, gross_weight, stone_weight,
         rate_per_gram, making_charge, gst_pct, qty, huid, return_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        returnId,
        nullable(it.productId) || 'MANUAL',
        nullable(it.name) || 'Returned item',
        nullable(it.purity),
        numberValue(it.netWeight),
        it.grossWeight === undefined ? null : numberValue(it.grossWeight),
        it.stoneWeight === undefined ? null : numberValue(it.stoneWeight),
        numberValue(it.ratePerGram),
        numberValue(it.makingCharge),
        numberValue(it.gstPct),
        it.qty === undefined || it.qty === null ? 1 : numberValue(it.qty, 1),
        nullable(it.huid),
        numberValue(it.returnAmount),
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

    let totalReturns = 0;
    let totalItems = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);
      const shopCheck = await pg.query(`SELECT id FROM shops WHERE id = $1`, [shopId]);
      if (!shopCheck.rowCount) {
        console.log(`\n⚠ Skipping ${shop.slug}: PostgreSQL shop not found`);
        continue;
      }

      const db = mongo.useDb(shop.dbName, { useCache: false });
      const returns = await db.db
        .collection('salesreturns')
        .find({})
        .sort({ createdAt: 1 })
        .toArray();
      if (!returns.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${returns.length} sales returns`);

      for (const r of returns) {
        if (!r.returnNo) {
          console.log('  ⚠ Skipping sales return with no returnNo');
          continue;
        }
        const returnNo = String(r.returnNo);

        const existing = await pg.query(
          `SELECT id FROM sales_returns WHERE shop_id = $1 AND return_no = $2 LIMIT 1`,
          [shopId, returnNo]
        );

        let returnId;
        if (existing.rowCount) {
          returnId = existing.rows[0].id;
          const backfilled = await migrateReturnItems(pg, returnId, r.items);
          totalItems += backfilled;
          console.log(`  ↻ ${returnNo} [already migrated]${backfilled ? ` (+${backfilled} items)` : ''}`);
          continue;
        }

        const res = await pg.query(
          `INSERT INTO sales_returns
            (return_no, date, invoice_id, invoice_number, customer_id, customer_name,
             customer_mobile, subtotal, gst_amount, total_refund, refund_mode, reason, notes,
             created_at, updated_at, shop_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id`,
          [
            returnNo,
            toTs(r.date),
            nullable(r.invoiceId),
            nullable(r.invoiceNumber),
            nullable(r.customerId),
            nullable(r.customerName) || 'Customer',
            nullable(r.customerMobile),
            numberValue(r.subtotal),
            numberValue(r.gstAmount),
            numberValue(r.totalRefund),
            safeRefundMode(r.refundMode),
            nullable(r.reason),
            nullable(r.notes),
            toTs(r.createdAt),
            toTs(r.updatedAt),
            shopId,
          ]
        );
        returnId = res.rows[0].id;
        const n = await migrateReturnItems(pg, returnId, r.items);
        totalItems += n;
        totalReturns += 1;
        console.log(`  ✓ ${returnNo} [${returnId}]${n ? ` (${n} items)` : ''}`);
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('SALES-RETURNS MIGRATION COMPLETE');
    console.log(`Sales returns migrated: ${totalReturns}`);
    console.log(`Return items migrated: ${totalItems}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nSALES-RETURNS MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
