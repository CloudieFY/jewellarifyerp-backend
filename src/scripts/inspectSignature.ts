import 'dotenv/config';
import mongoose from 'mongoose';
import { buildDbUri } from '../config/masterDb';

async function main() {
  const conn = mongoose.createConnection(buildDbUri('shop_demo'), {
    serverSelectionTimeoutMS: 10000,
  });

  await new Promise<void>((resolve, reject) => {
    conn.once('open', () => resolve());
    conn.once('error', reject);
  });

  try {
    const db = conn.db;
    if (!db) throw new Error('Database handle unavailable');

    const doc: any = await db.collection('orders').findOne({});

    if (!doc) {
      console.log('No order found');
      return;
    }

    for (const field of ['sampleImageUrl', 'customerSignature', 'authorizedSignatory']) {
      const value = doc[field];

      console.log('\n--------------------------------');
      console.log('FIELD:', field);
      console.log('TYPE:', typeof value);

      if (typeof value === 'string') {
        console.log('Length:', value.length);
        console.log('First 150 chars:', value.substring(0, 150));

        if (value.startsWith('data:image/')) {
          console.log('FORMAT: Base64 Data URL');
        } else if (value.startsWith('http://') || value.startsWith('https://')) {
          console.log('FORMAT: Remote URL');
        } else {
          console.log('FORMAT: String / Unknown');
        }
      } else {
        console.log('Value:', value);
      }
    }
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
