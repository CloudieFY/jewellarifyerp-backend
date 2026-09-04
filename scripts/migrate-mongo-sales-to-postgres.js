/*
 * Migrate the tenant `sales` collection (Mongo) -> `sales` + `sale_items` (PG).
 *
 * The Mongo `sales` doc embeds an `items[]` array (itemName/quantity/rate/
 * amount) which becomes the `sale_items` child table.
 *
 * `sales` has no natural business key (no sale number), so "already migrated"
 * is decided by the tuple (shop_id, created_at, customer_id, total_amount).
 * Mongo `createdAt` is millisecond-precise, so collisions are effectively nil.
 *
 * Idempotent. Usage:  node scripts/migrate-mongo-sales-to-postgres.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toDate(value) {
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
function safeStatus(v) {
  return ['pending', 'completed', 'cancelled'].includes(v) ? v : 'pending';
}
function safePaymentStatus(v) {
  return ['pending', 'paid', 'partial'].includes(v) ? v : 'pending';
}

async function migrateSaleItems(pg, saleId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const existing = await pg.query(`SELECT 1 FROM sale_items WHERE sale_id = $1 LIMIT 1`, [saleId]);
  if (existing.rowCount) return 0;

  let n = 0;
  for (const it of items) {
    await pg.query(
      `INSERT INTO sale_items (sale_id, item_name, quantity, rate, amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        saleId,
        nullable(it.itemName) || 'Item',
        it.quantity === undefined || it.quantity === null ? 1 : numberValue(it.quantity, 1),
        numberValue(it.rate),
        numberValue(it.amount),
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

    let totalSales = 0;
    let totalItems = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);
      const shopCheck = await pg.query(`SELECT id FROM shops WHERE id = $1`, [shopId]);
      if (!shopCheck.rowCount) {
        console.log(`\n⚠ Skipping ${shop.slug}: PostgreSQL shop not found`);
        continue;
      }

      const db = mongo.useDb(shop.dbName, { useCache: false });
      const sales = await db.db.collection('sales').find({}).sort({ createdAt: 1 }).toArray();
      if (!sales.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${sales.length} sales`);

      for (const sale of sales) {
        const createdAt = toDate(sale.createdAt);
        const customerId = nullable(sale.customerId);
        const totalAmount = numberValue(sale.totalAmount);

        const existing = await pg.query(
          `SELECT id FROM sales
            WHERE shop_id = $1 AND created_at = $2
              AND customer_id IS NOT DISTINCT FROM $3 AND total_amount = $4
            LIMIT 1`,
          [shopId, createdAt, customerId, totalAmount]
        );

        let saleId;
        if (existing.rowCount) {
          saleId = existing.rows[0].id;
          const backfilled = await migrateSaleItems(pg, saleId, sale.items);
          totalItems += backfilled;
          console.log(`  ↻ ${saleId} [already migrated]${backfilled ? ` (+${backfilled} items)` : ''}`);
        } else {
          const res = await pg.query(
            `INSERT INTO sales
              (customer_id, total_amount, status, payment_status, notes, created_at, updated_at, shop_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id`,
            [
              customerId || '',
              totalAmount,
              safeStatus(sale.status),
              safePaymentStatus(sale.paymentStatus),
              nullable(sale.notes),
              createdAt,
              toDate(sale.updatedAt),
              shopId,
            ]
          );
          saleId = res.rows[0].id;
          const n = await migrateSaleItems(pg, saleId, sale.items);
          totalItems += n;
          totalSales += 1;
          console.log(`  ✓ ${saleId}${n ? ` (${n} items)` : ''}`);
        }
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('SALES MIGRATION COMPLETE');
    console.log(`Sales migrated: ${totalSales}`);
    console.log(`Line items migrated: ${totalItems}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nSALES MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
