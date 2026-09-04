import 'dotenv/config';
import { connectMaster, getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';

async function main() {
  const conn = await connectMaster();
  const Shop = getShopModel(conn);

  const shops = await Shop.find({}).lean();

  console.log(`Total shops: ${shops.length}`);

  for (const shop of shops) {
    console.log('\n========================================');
    console.log(`SHOP: ${shop.shopName}`);
    console.log('========================================');

    const output: any = { ...shop };

    if (output._id?.buffer) {
      output._id = `[Mongo ObjectId: ${output._id.toString?.() || 'ObjectId'}]`;
    }

    console.log(JSON.stringify(output, null, 2));
  }

  await getMasterConnection().close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
