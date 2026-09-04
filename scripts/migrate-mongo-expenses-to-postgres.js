/*
 * Migrate tenant `expenses` (Mongo) -> `expenses` (PG).
 *
 * No natural key. "Already migrated" = (shop_id, created_at, amount,
 * description). Idempotent.
 *
 * Usage:  node scripts/migrate-mongo-expenses-to-postgres.js
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
function safeExpenseType(v) {
  return v === 'Direct' ? 'Direct' : 'Indirect';
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
      const expenses = await db.db.collection('expenses').find({}).sort({ createdAt: 1 }).toArray();
      if (!expenses.length) continue;

      console.log(`\n${shop.slug} (${shop.dbName}) -> ${expenses.length} expenses`);

      for (const e of expenses) {
        const createdAt = toTs(e.createdAt);
        const amount = numberValue(e.amount);
        const description = nullable(e.description) || 'Expense';

        const existing = await pg.query(
          `SELECT id FROM expenses
            WHERE shop_id = $1 AND created_at = $2 AND amount = $3 AND description = $4
            LIMIT 1`,
          [shopId, createdAt, amount, description]
        );
        if (existing.rowCount) {
          console.log(`  ↻ ${description} / ${amount} [already migrated]`);
          continue;
        }

        await pg.query(
          `INSERT INTO expenses
            (description, category, expense_type, amount, date, payment_mode,
             payee_name, voucher_no, notes, created_at, updated_at, shop_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            description,
            nullable(e.category) || 'General',
            safeExpenseType(e.expenseType),
            amount,
            toDateOnly(e.date) || createdAt.toISOString().slice(0, 10),
            nullable(e.paymentMode) || 'Cash',
            nullable(e.payeeName),
            nullable(e.voucherNo),
            nullable(e.notes),
            createdAt,
            toTs(e.updatedAt),
            shopId,
          ]
        );
        total += 1;
        console.log(`  ✓ ${description} / ${amount}`);
      }
    }

    await pg.query('COMMIT');
    console.log('\n========================================');
    console.log('EXPENSES MIGRATION COMPLETE');
    console.log(`Expenses migrated: ${total}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');
    console.error('\nEXPENSES MIGRATION FAILED\n', error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
