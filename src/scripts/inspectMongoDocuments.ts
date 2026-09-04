import 'dotenv/config';
import { connectMaster, getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';
import { getTenantContext } from '../config/tenantDb';

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'hashedPassword',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
  'otp',
  'resetToken',
];

function sanitize(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    const output: any = {};

    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
        output[key] = '[MASKED]';
      } else {
        output[key] = sanitize(val);
      }
    }

    return output;
  }

  return value;
}

async function inspectModel(
  shopName: string,
  collectionName: string,
  model: any
) {
  if (!model || typeof model.find !== 'function') {
    console.log(`\n[${collectionName}] MODEL NOT AVAILABLE`);
    return;
  }

  const count = await model.countDocuments();

  console.log(`\n========== ${shopName} :: ${collectionName} (${count}) ==========`);

  if (count === 0) {
    console.log('No documents');
    return;
  }

  const docs = await model.find({}).limit(2).lean();

  docs.forEach((doc: any, index: number) => {
    console.log(`\n--- Document ${index + 1} ---`);
    console.log(JSON.stringify(sanitize(doc), null, 2));
  });
}

async function main() {
  console.log('\n========================================');
  console.log(' JEWELLARIFY MONGODB DOCUMENT INSPECTION');
  console.log(' READ ONLY - NO DATA WILL BE CHANGED');
  console.log(' MAX 2 DOCUMENTS PER COLLECTION');
  console.log('========================================\n');

  const masterConn = await connectMaster();
  const Shop = getShopModel(masterConn);

  const shops = await Shop.find({}).lean();

  console.log(`Total shops found: ${shops.length}`);

  for (const shop of shops) {
    console.log('\n\n########################################');
    console.log(`SHOP: ${shop.shopName}`);
    console.log(`ID: ${shop._id}`);
    console.log(`SLUG: ${shop.slug}`);
    console.log(`DB: ${shop.dbName}`);
    console.log('########################################');

    try {
      const models = await getTenantContext(shop.dbName);

      const collections: Record<string, any> = {
        users: models.User,
        customers: models.Customer,
        suppliers: models.Supplier,
        inventory: models.Inventory,
        sales: models.Sales,
        purchases: models.Purchases,
        expenses: models.Expenses,
        karigars: models.Karigars,
        goldRates: models.GoldRates,
        repairs: models.Repair,
        invoices: models.Invoice,
        salesReturns: models.SalesReturn,
        advances: models.Advance,
        girvi: models.Girvi,
        orders: models.Order,
        employees: models.Employee,
        schemes: models.Scheme,

        categories: models.Category,
        subCategories: models.SubCategory,
        brands: models.Brand,
        collections: models.CollectionMaster,
        purities: models.PurityMaster,
        metals: models.MetalMaster,
        stones: models.StoneMaster,
        diamonds: models.DiamondMaster,
        units: models.UnitMaster,
        hsn: models.HsnMaster,

        stockAdjustments: models.StockAdjustment,
        stockTransfers: models.StockTransfer,
        stockLedger: models.StockLedger,
        openingStock: models.OpeningStock,
      };

      for (const [name, model] of Object.entries(collections)) {
        await inspectModel(shop.shopName, name, model);
      }
    } catch (error: any) {
      console.error(`\nERROR inspecting ${shop.dbName}`);
      console.error(error?.message || error);
    }
  }

  console.log('\n========================================');
  console.log(' Document inspection completed');
  console.log(' READ ONLY');
  console.log('========================================\n');

  try {
    await getMasterConnection().close();
  } catch {}

  process.exit(0);
}

main().catch((error) => {
  console.error('\nInspection failed:');
  console.error(error);
  process.exit(1);
});
