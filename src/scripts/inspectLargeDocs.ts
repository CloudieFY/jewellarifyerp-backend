import 'dotenv/config';
import mongoose from 'mongoose';
import { buildDbUri } from '../config/masterDb';

async function inspectCollection(dbName: string, collectionName: string) {
  const conn = mongoose.createConnection(buildDbUri(dbName), {
    serverSelectionTimeoutMS: 10000,
  });

  await new Promise<void>((resolve, reject) => {
    conn.once('open', () => resolve());
    conn.once('error', reject);
  });

  try {
    const db = conn.db;

    if (!db) throw new Error('Database handle unavailable');

    const docs = await db
      .collection(collectionName)
      .find({})
      .sort({ _id: 1 })
      .limit(10)
      .toArray();

    console.log(`\n========================================`);
    console.log(`${dbName}.${collectionName}`);
    console.log(`Documents: ${docs.length}`);
    console.log(`========================================`);

    for (const doc of docs) {
      const json = JSON.stringify(doc);

      console.log('\n----------------------------------------');
      console.log('ID:', doc._id);
      console.log(
        'Approx JSON size:',
        (Buffer.byteLength(json, 'utf8') / 1024 / 1024).toFixed(3),
        'MB'
      );

      console.log('Top-level fields:');

      for (const [key, value] of Object.entries(doc)) {
        let size = 0;

        try {
          size = Buffer.byteLength(JSON.stringify(value), 'utf8');
        } catch {
          size = 0;
        }

        console.log(
          `  ${key}: ${(size / 1024).toFixed(2)} KB`,
          Array.isArray(value)
            ? `(array: ${value.length} items)`
            : typeof value === 'object' && value !== null
              ? '(object)'
              : `(${typeof value})`
        );
      }
    }
  } finally {
    await conn.close();
  }
}

async function main() {
  console.log(`
========================================
 JEWELLARIFY LARGE DOCUMENT INSPECTION
 READ ONLY
========================================
`);

  await inspectCollection('shop_demo', 'orders');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
