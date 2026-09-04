/*
 * Migrate tenant `goldrates` (Mongo) -> `gold_rates` (PG).
 *
 * Every shop keeps a running history of daily rate snapshots. No natural key,
 * so "already migrated" = (shop_id, created_at) — Mongo `createdAt` is
 * millisecond-precise, collisions are nil.
 *
 * Idempotent. Usage:  node scripts/migrate-mongo-gold-rates-to-postgres.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toTs(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function numberValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
      const rates = await db.db.collection('goldrates').find({}).sort({ createdAt: 1 }).toArray();
      if (!rates.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${rates.length} gold-rate snapshots`);

      for (const g of rates) {
        const createdAt = toTs(g.createdAt);
        const existing = await pg.query(
          `SELECT id FROM gold_rates WHERE shop_id = $1 AND created_at = $2 LIMIT 1`,
          [shopId, createdAt]
        );
        if (existing.rowCount) {
          console.log(`  ↻ ${createdAt.toISOString()} [already migrated]`);
          continue;
        }

        await pg.query(
          `INSERT INTO gold_rates (gold24, gold22, gold20, gold18, silver, created_at, updated_at, shop_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            numberValue(g.gold24),
            numberValue(g.gold22),
            numberValue(g.gold20),
            numberValue(g.gold18),
            numberValue(g.silver),
            createdAt,
            toTs(g.updatedAt),
            shopId,
          ]
        );
        total += 1;
        console.log(`  ✓ ${createdAt.toISOString()}  (24k=${numberValue(g.gold24)})`);
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('GOLD-RATES MIGRATION COMPLETE');
    console.log(`Snapshots migrated: ${total}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nGOLD-RATES MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
