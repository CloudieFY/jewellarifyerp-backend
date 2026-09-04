import 'dotenv/config';
import mongoose from 'mongoose';
import { buildDbUri } from '../config/masterDb';

const databases = [
  'shop_roopam_jewellers',
  'shop_sitara_aath_jewellers',
  'shop_soni_jewellers',
  'shop_patel',
  'shop_jitendra_jewellers',
  'shop_demo',
  'shop_rajasthan_jewellers',
];

const THRESHOLD_MB = 0.25;

async function inspectDatabase(dbName: string) {
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

    const collections = await db.listCollections().toArray();

    console.log(`\n========================================`);
    console.log(`DATABASE: ${dbName}`);
    console.log(`========================================`);

    for (const info of collections) {
      const collectionName = info.name;

      const docs = await db
        .collection(collectionName)
        .find({})
        .toArray();

      for (const doc of docs) {
        const json = JSON.stringify(doc);
        const sizeMB =
          Buffer.byteLength(json, 'utf8') / 1024 / 1024;

        if (sizeMB < THRESHOLD_MB) continue;

        console.log(`\n----------------------------------------`);
        console.log(`${dbName}.${collectionName}`);
        console.log(`ID: ${doc._id}`);
        console.log(`Document size: ${sizeMB.toFixed(3)} MB`);

        const fields: {
          field: string;
          sizeKB: number;
          type: string;
          format?: string;
        }[] = [];

        for (const [key, value] of Object.entries(doc)) {
          let size = 0;

          try {
            size = Buffer.byteLength(
              JSON.stringify(value),
              'utf8'
            );
          } catch {
            continue;
          }

          const sizeKB = size / 1024;

          if (sizeKB < 10) continue;

          let format = '';

          if (typeof value === 'string') {
            if (value.startsWith('data:image/')) {
              format = 'BASE64 IMAGE';
            } else if (
              value.startsWith('http://') ||
              value.startsWith('https://')
            ) {
              format = 'URL';
            }
          }

          fields.push({
            field: key,
            sizeKB,
            type: Array.isArray(value)
              ? 'array'
              : typeof value,
            format,
          });
        }

        fields
          .sort((a, b) => b.sizeKB - a.sizeKB)
          .forEach((f) => {
            console.log(
              `  ${f.field}: ${f.sizeKB.toFixed(2)} KB` +
              ` (${f.type})` +
              (f.format ? ` [${f.format}]` : '')
            );
          });
      }
    }
  } finally {
    await conn.close();
  }
}

async function main() {
  console.log(`
========================================
 JEWELLARIFY LARGE DOCUMENT SCAN
 READ ONLY
 Threshold: ${THRESHOLD_MB} MB
========================================
`);

  for (const dbName of databases) {
    try {
      await inspectDatabase(dbName);
    } catch (error: any) {
      console.error(
        `ERROR: ${dbName}:`,
        error.message
      );
    }
  }

  console.log(`
========================================
 LARGE DOCUMENT SCAN COMPLETED
========================================
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
