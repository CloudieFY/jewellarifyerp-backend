import 'dotenv/config';
import { connectMaster, getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';
import { getTenantContext } from '../config/tenantDb';

async function countModel(model: any): Promise<number> {
  if (!model || typeof model.countDocuments !== 'function') {
    return -1;
  }

  return model.countDocuments();
}

async function main() {
  console.log('\n========================================');
  console.log(' JEWELLARIFY MONGODB INSPECTION');
  console.log(' READ ONLY - NO DATA WILL BE CHANGED');
  console.log('========================================\n');

  const masterConn = await connectMaster();
  const Shop = getShopModel(masterConn);

  const shops = await Shop.find({}).lean();

  console.log(`Total shops found: ${shops.length}\n`);

  for (const shop of shops) {
    console.log('----------------------------------------');
    console.log(`Shop Name : ${shop.shopName}`);
    console.log(`Shop ID   : ${shop._id}`);
    console.log(`Slug      : ${shop.slug}`);
    console.log(`DB Name   : ${shop.dbName}`);
    console.log(`Status    : ${shop.status}`);
    console.log(`Plan      : ${shop.plan}`);

    try {
      const models = await getTenantContext(shop.dbName);

      const counts = {
        users: await countModel(models.User),
        customers: await countModel(models.Customer),
        suppliers: await countModel(models.Supplier),
        inventory: await countModel(models.Inventory),
        sales: await countModel(models.Sales),
        purchases: await countModel(models.Purchases),
        expenses: await countModel(models.Expenses),
        karigars: await countModel(models.Karigars),
        goldRates: await countModel(models.GoldRates),
        repairs: await countModel(models.Repair),
        invoices: await countModel(models.Invoice),
        salesReturns: await countModel(models.SalesReturn),
        advances: await countModel(models.Advance),
        girvi: await countModel(models.Girvi),
        orders: await countModel(models.Order),
        employees: await countModel(models.Employee),
        schemes: await countModel(models.Scheme),

        categories: await countModel(models.Category),
        subCategories: await countModel(models.SubCategory),
        brands: await countModel(models.Brand),
        collections: await countModel(models.CollectionMaster),
        purities: await countModel(models.PurityMaster),
        metals: await countModel(models.MetalMaster),
        stones: await countModel(models.StoneMaster),
        diamonds: await countModel(models.DiamondMaster),
        units: await countModel(models.UnitMaster),
        hsn: await countModel(models.HsnMaster),

        stockAdjustments: await countModel(models.StockAdjustment),
        stockTransfers: await countModel(models.StockTransfer),
        stockLedger: await countModel(models.StockLedger),
        openingStock: await countModel(models.OpeningStock),
      };

      console.log('\nCollection counts:');
      console.table(counts);

      const failed = Object.entries(counts)
        .filter(([, value]) => value === -1)
        .map(([key]) => key);

      if (failed.length) {
        console.log('\nWARNING: Models unavailable:');
        console.log(failed.join(', '));
      }
    } catch (error: any) {
      console.error(`\nERROR inspecting ${shop.dbName}`);
      console.error(error.message);
    }
  }

  console.log('\n========================================');
  console.log(' Inspection completed');
  console.log('========================================\n');

  // Close the master connection gracefully.
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
