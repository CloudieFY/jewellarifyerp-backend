import 'dotenv/config';
import { connectPostgres, pgPool } from '../config/postgres';

async function main() {
  try {
    await connectPostgres();

    const result = await pgPool.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        inet_server_port() AS port
    `);

    console.log(result.rows[0]);
  } finally {
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error('[PostgreSQL TEST FAILED]', err);
  process.exit(1);
});
