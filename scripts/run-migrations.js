/*
 * Idempotent SQL migration runner.
 *
 * Applies every migrations/*.sql that has not been recorded in the
 * `schema_migrations` table yet, each inside its own transaction.
 *
 * The first four files (001-004) were applied by hand before this runner
 * existed and the live DB already has all 44 tables, so they are recorded as
 * "applied" WITHOUT being re-executed. Everything from 005 onwards is written
 * to be idempotent (IF NOT EXISTS) and is executed normally.
 *
 * Usage:  node scripts/run-migrations.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const BASELINE = new Set([
  '001_initial_schema.sql',
  '002_business_schema.sql',
  '003_tenant_isolation.sql',
  '004_jobworks.sql',
]);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`= skip   ${file} (already applied)`);
        continue;
      }

      if (BASELINE.has(file)) {
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        console.log(`~ baseline ${file} (recorded, not executed)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
        console.log(`+ applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`! FAILED  ${file}: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    const final = await pool.query(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY filename'
    );
    console.log('\nschema_migrations:');
    for (const r of final.rows) {
      console.log(`  ${r.filename}\t${r.applied_at.toISOString()}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
