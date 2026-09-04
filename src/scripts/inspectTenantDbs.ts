import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMaster, getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';

async function main() {
  await connectMaster();

  const masterConn = getMasterConnection();
  const Shop = getShopModel(masterConn);

  const shops = await Shop.find({}).lean();

  console.log(`\nTotal shops: ${shops.length}\n`);

  for (const shop of shops) {
    console.log(`\n========================================`);
    console.log(`SHOP: ${shop.shopName}`);
    console.log(`DB:   ${shop.dbName}`);
    console.log(`========================================`);

    const uri = process.env.MONGODB_BASE_URI!;
    const cleanUri = uri.endsWith('/')
      ? `${uri}${shop.dbName}`
      : `${uri}/${shop.dbName}`;

    const conn = await mongoose.createConnection(cleanUri).asPromise();

    try {
      const db = conn.db;
      if (!db) throw new Error(`MongoDB database handle unavailable for ${shop.dbName}`);

      const collections = await db.listCollections().toArray();

      console.log(`Collections: ${collections.length}`);

      for (const collection of collections) {
        const count = await db
          .collection(collection.name)
          .countDocuments();

        console.log(`  ${collection.name}: ${count}`);
      }
    } finally {
      await conn.close();
    }
  }

  await masterConn.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
