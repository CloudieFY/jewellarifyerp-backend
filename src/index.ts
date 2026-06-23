import 'dotenv/config';
import express from 'express';
import { connectMaster } from './config/masterDb';
import { errorHandler, corsMiddleware } from './middleware/errorHandler';

import superAdminRouter from './routes/superAdmin';
import tenantAuthRouter from './routes/tenantAuth';

import customersRouter from './routes/customers';
import suppliersRouter from './routes/suppliers';
import inventoryRouter from './routes/inventory';
import salesRouter from './routes/sales';
import purchasesRouter from './routes/purchases';
import expensesRouter from './routes/expenses';
import karigarsRouter from './routes/karigars';
import jobworkRouter from './routes/jobwork';
import goldRatesRouter from './routes/gold-rates';
import repairsRouter from './routes/repairs';
import invoicesRouter from './routes/invoices';
import advancesRouter from './routes/advances';
import girviRouter from './routes/girvi';
import ordersRouter from './routes/orders';
import employeesRouter from './routes/employees';
import schemesRouter from './routes/schemes';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(corsMiddleware);

app.use((req, _res, next) => {
  console.log(`\n[API] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK' });
});

/* ------------------------------------------------------------------ */
/* Platform control-plane routes (super admin only)                    */
/* ------------------------------------------------------------------ */
app.use('/api/superadmin', superAdminRouter);

/* ------------------------------------------------------------------ */
/* Shop (tenant) auth - login, profile, user management                */
/* ------------------------------------------------------------------ */
app.use('/api/auth', tenantAuthRouter);

/* ------------------------------------------------------------------ */
/* Tenant-scoped business data routes - every one of these requires a  */
/* valid tenant JWT (see requireTenantAuth inside each route file) and */
/* is automatically isolated to the caller's own shop database.        */
/* ------------------------------------------------------------------ */
app.use('/api/customers', customersRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/sales', salesRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/karigars', karigarsRouter);
app.use('/api/jobwork', jobworkRouter);
app.use('/api/gold-rates', goldRatesRouter);
app.use('/api/repairs', repairsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/advances', advancesRouter);
app.use('/api/girvi', girviRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/schemes', schemesRouter);

app.use(errorHandler);

const PORT = process.env.PORT || 3006;

async function start() {
  try {
    await connectMaster();
    app.listen(PORT, () => {
      console.log(`\n✅ JewelShop SaaS backend running on port ${PORT}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export default app;
