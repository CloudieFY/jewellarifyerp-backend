import 'dotenv/config';
import express from 'express';
import { connectPostgres, pgPool } from './config/postgres';
import { errorHandler, corsMiddleware } from './middleware/errorHandler';

import tenantAuthPgRouter from './routes/tenantAuthPg';
import customersPgRouter from './routes/customersPg';
import suppliersPgRouter from './routes/suppliersPg';
import karigarsPgRouter from './routes/karigarsPg';
import inventoryPgRouter from './routes/inventoryPg';
import invoicesPgRouter from './routes/invoicesPg';
import salesPgRouter from './routes/salesPg';
import purchasesPgRouter from './routes/purchasesPg';
import expensesPgRouter from './routes/expensesPg';
import goldRatesPgRouter from './routes/goldRatesPg';
import repairsPgRouter from './routes/repairsPg';
import salesReturnsPgRouter from './routes/salesReturnsPg';
import advancesPgRouter from './routes/advancesPg';
import girviPgRouter from './routes/girviPg';
import ordersPgRouter from './routes/ordersPg';
import employeesPgRouter from './routes/employeesPg';
import schemesPgRouter from './routes/schemesPg';
import inventoryExtendedPgRouter from './routes/inventoryExtendedPg';
import superAdminPgRouter from './routes/superAdminPg';
import publicPgRouter from './routes/publicPg';

/**
 * PostgreSQL test server (core-first migration).
 *
 * Runs the ported API against PostgreSQL ONLY: the platform control plane
 * (superadmin) plus every tenant route index.ts mounts — auth, customers,
 * suppliers, karigars, inventory (+ inventory-extended), invoices, sales,
 * purchases, expenses, gold-rates, repairs, sales-returns, advances, girvi,
 * orders, employees, schemes. It shares no code path with the live Mongo
 * server (`src/index.ts`); nothing here imports mongoose. Meant to run on a
 * separate port for verification against the real frontend before any
 * production cutover.
 */

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(corsMiddleware);

app.use((req, _res, next) => {
  console.log(`\n[API/pg] ${req.method} ${req.path}`);
  next();
});

app.get('/health', async (_req, res) => {
  try {
    await pgPool.query('SELECT 1');
    res.json({ status: 'OK', db: 'postgres' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message });
  }
});

app.use('/api/public', publicPgRouter);
app.use('/api/superadmin', superAdminPgRouter);
app.use('/api/auth', tenantAuthPgRouter);
app.use('/api/customers', customersPgRouter);
app.use('/api/suppliers', suppliersPgRouter);
app.use('/api/karigars', karigarsPgRouter);
app.use('/api/inventory', inventoryPgRouter);
app.use('/api/inventory-extended', inventoryExtendedPgRouter);
app.use('/api/invoices', invoicesPgRouter);
app.use('/api/sales', salesPgRouter);
app.use('/api/purchases', purchasesPgRouter);
app.use('/api/expenses', expensesPgRouter);
app.use('/api/gold-rates', goldRatesPgRouter);
app.use('/api/repairs', repairsPgRouter);
app.use('/api/sales-returns', salesReturnsPgRouter);
app.use('/api/advances', advancesPgRouter);
app.use('/api/girvi', girviPgRouter);
app.use('/api/orders', ordersPgRouter);
app.use('/api/employees', employeesPgRouter);
app.use('/api/schemes', schemesPgRouter);

app.use(errorHandler);

const PORT = process.env.PG_PORT || 3011;

async function start() {
  try {
    await connectPostgres();
    const server = app.listen(PORT, () => {
      console.log(`\n✅ JewelShop PG test backend running on port ${PORT}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Shutdown] ${signal} received, closing server and PG pool...`);
      server.close(async () => {
        try {
          await pgPool.end();
          console.log('[Shutdown] PG pool closed. Exiting.');
          process.exit(0);
        } catch (err) {
          console.error('[Shutdown] Error closing PG pool:', err);
          process.exit(1);
        }
      });
      server.closeIdleConnections();
      setTimeout(() => {
        console.warn('[Shutdown] Forcing exit after timeout.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start PG test server:', err);
    process.exit(1);
  }
}

start();

export default app;
