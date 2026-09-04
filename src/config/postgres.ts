import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set');
}

export const pgPool = new Pool({
  connectionString: databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pgPool.on('error', (err) => {
  console.error('[PostgreSQL] Pool error:', err);
});

export async function connectPostgres() {
  const client = await pgPool.connect();

  try {
    await client.query('SELECT 1');
    console.log('[PostgreSQL] connected');
  } finally {
    client.release();
  }
}
