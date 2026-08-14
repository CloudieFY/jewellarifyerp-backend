import 'dotenv/config';
import express from 'express';
import { connectMaster, getMasterConnection } from './config/masterDb';
import { errorHandler, corsMiddleware } from './middleware/errorHandler';
import { getTenantContext } from './config/tenantDb';
import { getShopModel } from './models/master/Shop';

import superAdminRouter from './routes/superAdmin';
import tenantAuthRouter from './routes/tenantAuth';

import customersRouter from './routes/customers';
import suppliersRouter from './routes/suppliers';
import inventoryRouter from './routes/inventory';
import inventoryExtendedRouter from './routes/inventory-extended';
import salesRouter from './routes/sales';
import purchasesRouter from './routes/purchases';
import expensesRouter from './routes/expenses';
import karigarsRouter from './routes/karigars';
import goldRatesRouter from './routes/gold-rates';
import repairsRouter from './routes/repairs';
import invoicesRouter from './routes/invoices';
import advancesRouter from './routes/advances';
import girviRouter from './routes/girvi';
import ordersRouter from './routes/orders';
import employeesRouter from './routes/employees';
import schemesRouter from './routes/schemes';
import salesReturnsRouter from './routes/sales-returns';

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
/* Public Catalog Image Serving Route for WhatsApp Preview & Links    */
/* ------------------------------------------------------------------ */
app.get('/api/public/inventory-image/:dbName/:inventoryId', async (req, res) => {
  try {
    const { dbName, inventoryId } = req.params;
    const tenantModels = await getTenantContext(dbName);
    const item = await tenantModels.Inventory.findById(inventoryId).lean();
    if (!item || !(item as any).imageUrl) {
      return res.status(404).send('Image not found');
    }

    const img: string = (item as any).imageUrl;
    if (img.startsWith('data:')) {
      const matches = img.match(/^data:(.+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mime = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    } else if (img.startsWith('http://') || img.startsWith('https://')) {
      return res.redirect(img);
    }

    return res.status(404).send('Invalid image format');
  } catch (err) {
    console.error('Public inventory image error:', err);
    return res.status(500).send('Error serving image');
  }
});

app.get('/api/public/inventory-item/:dbName/:inventoryId', async (req, res) => {
  try {
    const { dbName, inventoryId } = req.params;
    const tenantModels = await getTenantContext(dbName);
    const item = await tenantModels.Inventory.findById(inventoryId).lean();
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    let shopInfo = { shopName: 'Jewellery Shop', phone: '', address: '', logoUrl: '' };
    try {
      const masterConn = getMasterConnection();
      const ShopModel = getShopModel(masterConn);
      const shop = await ShopModel.findOne({ dbName }).lean();
      if (shop) {
        shopInfo = {
          shopName: shop.shopName || 'Jewellery Shop',
          phone: shop.phone || '',
          address: shop.address || '',
          logoUrl: shop.logoUrl || '',
        };
      }
    } catch (e) {
      console.error('Fetch shop info error:', e);
    }

    return res.json({ item, shop: shopInfo });
  } catch (err) {
    console.error('Public inventory item error:', err);
    return res.status(500).json({ error: 'Error fetching product' });
  }
});

app.get('/api/public/inventory-item-by-id/:inventoryId', async (req, res) => {
  try {
    const { inventoryId } = req.params;
    const masterConn = getMasterConnection();
    const ShopModel = getShopModel(masterConn);
    const shops = await ShopModel.find({ status: 'active' }).lean();

    for (const shop of shops) {
      try {
        const tenantModels = await getTenantContext(shop.dbName);
        const item = await tenantModels.Inventory.findById(inventoryId).lean();
        if (item) {
          return res.json({
            item,
            shop: {
              shopName: shop.shopName || 'Jewellery Shop',
              phone: shop.phone || '',
              address: shop.address || '',
              logoUrl: shop.logoUrl || '',
            },
          });
        }
      } catch (e) {}
    }

    return res.status(404).json({ error: 'Item not found' });
  } catch (err) {
    console.error('Public inventory item error:', err);
    return res.status(500).json({ error: 'Error fetching product' });
  }
});

app.get('/api/public/invoice/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const masterConn = getMasterConnection();
    const ShopModel = getShopModel(masterConn);
    const shops = await ShopModel.find({ status: 'active' }).lean();

    for (const shop of shops) {
      try {
        const tenantModels = await getTenantContext(shop.dbName);
        const inv = await tenantModels.Invoice.findById(invoiceId).lean();
        if (inv) {
          return res.json({
            invoice: inv,
            shop: {
              shopName: shop.shopName || 'Jewellery Shop',
              phone: shop.phone || '',
              address: shop.address || '',
              logoUrl: shop.logoUrl || '',
              gstNumber: shop.gstNumber || '',
              invoiceSettings: shop.invoiceSettings || {},
            },
          });
        }
      } catch (e) {}
    }

    return res.status(404).json({ error: 'Invoice not found' });
  } catch (err) {
    console.error('Public invoice error:', err);
    return res.status(500).json({ error: 'Error fetching invoice' });
  }
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
app.use('/api/inventory-extended', inventoryExtendedRouter);
app.use('/api/sales', salesRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/karigars', karigarsRouter);
app.use('/api/gold-rates', goldRatesRouter);
app.use('/api/repairs', repairsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/sales-returns', salesReturnsRouter);
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
