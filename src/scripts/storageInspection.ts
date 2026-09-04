import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMaster, getMasterConnection, buildDbUri } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';

async function inspectDatabase(dbName: string) {
  const uri = buildDbUri(dbName);

  const conn = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  await new Promise<void>((resolve, reject) => {
    conn.once('open', () => resolve());
    conn.once('error', reject);
  });

  try {
    const db = conn.db;

    if (!db) {
      throw new Error(`Mongo database handle unavailable for ${dbName}`);
    }

    const stats = await db.stats();

    const collections = await db.listCollections({}, { nameOnly: true }).toArray();

    const collectionStats: any[] = [];

    for (const collection of collections) {
      try {
        const result = await db.command({
          collStats: collection.name,
        });

        collectionStats.push({
          collection: collection.name,
          documents: result.count ?? 0,
          dataSizeMB: Number(((result.size ?? 0) / 1024 / 1024).toFixed(3)),
          storageSizeMB: Number(((result.storageSize ?? 0) / 1024 / 1024).toFixed(3)),
          indexesSizeMB: Number(((result.totalIndexSize ?? 0) / 1024 / 1024).toFixed(3)),
        });
      } catch {
        // Ignore collections that don't expose collStats.
      }
    }

    console.log(`\n========== ${dbName} ==========`);

    console.log({
      collections: stats.collections,
      objects: stats.objects,
      dataSizeMB: Number(((stats.dataSize ?? 0) / 1024 / 1024).toFixed(3)),
      storageSizeMB: Number(((stats.storageSize ?? 0) / 1024 / 1024).toFixed(3)),
      indexesSizeMB: Number(((stats.indexSize ?? 0) / 1024 / 1024).toFixed(3)),
      totalSizeMB: Number(
        (((stats.storageSize ?? 0) + (stats.indexSize ?? 0)) / 1024 / 1024).toFixed(3)
      ),
    });

    console.table(collectionStats);
  } finally {
    await conn.close();
  }
}

async function main() {
  console.log('\n========================================');
  console.log(' JEWELLARIFY MONGODB STORAGE INSPECTION');
  console.log(' READ ONLY');
  console.log('========================================');

  const masterConn = await connectMaster();
  const Shop = getShopModel(masterConn);

  const shops = await Shop.find({}).lean();

  await inspectDatabase(process.env.MASTER_DB_NAME || 'jewelshop_master');

  for (const shop of shops) {
    await inspectDatabase(shop.dbName);
  }

  await getMasterConnection().close();

  console.log('\n========================================');
  console.log(' STORAGE INSPECTION COMPLETED');
  console.log('========================================\n');

  process.exit(0);
}

main().catch((error) => {
  console.error('\nInspection failed:');
  console.error(error);
  process.exit(1);
});
