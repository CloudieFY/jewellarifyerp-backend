import 'dotenv/config';
import { connectPostgres, pgPool } from './config/postgres';
import { startOutboxWorker } from './crm/outbox/worker';
import { registerCrmOutboxHandlers } from './crm/outbox/handlers';

/**
 * CRM background worker (PostgreSQL only).
 *
 * A SEPARATE process from the Express API (src/serverPg.ts). It drains the
 * `crm_outbox` table using FOR UPDATE SKIP LOCKED, so it is safe to run more
 * than one instance.
 *
 * Run:   npm run worker:pg        (prod, compiled)
 *        npm run dev:worker       (dev, tsx watch)
 * PM2:   pm2 start dist/workerPg.js --name jewellarifyerp-worker
 */
async function start() {
  await connectPostgres();
  registerCrmOutboxHandlers();
  console.log('\n✅ JewelShop CRM worker (PG) started');

  const worker = startOutboxWorker({
    intervalMs: Number(process.env.CRM_WORKER_INTERVAL_MS) || 5000,
    batchSize: Number(process.env.CRM_WORKER_BATCH_SIZE) || 10,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Worker shutdown] ${signal} received, stopping loop and closing PG pool...`);
    try {
      await worker.stop();
      await pgPool.end();
      console.log('[Worker shutdown] clean. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('[Worker shutdown] error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash-safety net: don't leave a half-dead worker holding rows.
  setTimeout(() => {}, 1 << 30);
}

start().catch((err) => {
  console.error('Failed to start CRM worker:', err);
  process.exit(1);
});
