/*
 * Migrate master `superadmins` (Mongo) -> `superadmins` (PG).
 *
 * Control-plane accounts for the superadmin panel. They live on the MASTER
 * connection (MASTER_DB_NAME), not per-tenant, so the shop/user migrate
 * scripts never touched them — the PG cutover left PG with only the
 * `postgres_test_admin` seed row, so the real `superadmin` login 401s
 * ("no superadmin for username").
 *
 * Key = Mongo `_id` (carried across verbatim, like every other migrate
 * script) so re-runs upsert instead of duplicating. bcrypt hash is copied
 * as-is; no re-hashing.
 *
 * Idempotent. Usage:  node scripts/migrate-mongo-superadmins-to-postgres.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toTs(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function main() {
  const mongo = await mongoose.createConnection(process.env.MONGODB_BASE_URI).asPromise();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const master = mongo.useDb(process.env.MASTER_DB_NAME || 'jewelshop_master', { useCache: false });
    const admins = await master.db.collection('superadmins').find({}).toArray();

    console.log(`Found ${admins.length} Mongo superadmin(s).`);
    await pg.query('BEGIN');

    let upserted = 0;
    for (const a of admins) {
      const id = String(a._id);
      const username = String(a.username || '').toLowerCase().trim();
      if (!username || !a.passwordHash) {
        console.log(`\n⚠ Skipping ${id}: missing username or passwordHash`);
        continue;
      }
      const name = a.name || username;
      const createdAt = toTs(a.createdAt);
      const updatedAt = toTs(a.updatedAt);

      await pg.query(
        `INSERT INTO superadmins (id, username, password_hash, name, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           username      = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           name          = EXCLUDED.name,
           updated_at    = EXCLUDED.updated_at`,
        [id, username, a.passwordHash, name, createdAt, updatedAt]
      );
      console.log(`  ✓ ${username} (${id})`);
      upserted++;
    }

    await pg.query('COMMIT');
    console.log(`\nDone. Upserted ${upserted} superadmin(s).`);

    const { rows } = await pg.query('SELECT username, name FROM superadmins ORDER BY username');
    console.log('PG superadmins now:', rows.map((r) => r.username).join(', '));
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await mongo.close().catch(() => {});
    await pg.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
