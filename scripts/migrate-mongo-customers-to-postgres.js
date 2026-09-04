require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toDate(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function nullable(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
}

async function main() {
  const mongo = await mongoose.createConnection(
    process.env.MONGODB_BASE_URI
  ).asPromise();

  const pg = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const master = mongo.useDb(
      process.env.MASTER_DB_NAME || 'jewelshop_master',
      { useCache: false }
    );

    const shops = await master.db.collection('shops')
      .find({})
      .project({
        _id: 1,
        slug: 1,
        dbName: 1
      })
      .sort({ dbName: 1 })
      .toArray();

    console.log(`Found ${shops.length} Mongo shops.`);

    await pg.query('BEGIN');

    let totalCustomers = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);

      const shopCheck = await pg.query(
        `SELECT id FROM shops WHERE id = $1`,
        [shopId]
      );

      if (shopCheck.rowCount !== 1) {
        throw new Error(
          `PostgreSQL shop not found: ${shop.slug} (${shopId})`
        );
      }

      const db = mongo.useDb(shop.dbName, {
        useCache: false
      });

      const customers = await db.db.collection('customers')
        .find({})
        .toArray();

      if (!customers.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${customers.length} customers`
      );

      let shopMigrated = 0;

      for (const customer of customers) {
        if (!customer._id) {
          throw new Error(
            `Customer without _id in ${shop.dbName}: ${JSON.stringify(customer)}`
          );
        }

        if (!customer.name) {
          throw new Error(
            `Customer ${customer._id} has no name in ${shop.dbName}`
          );
        }

        const id = String(customer._id);

        await pg.query(
          `
          INSERT INTO customers (
            id,
            shop_id,
            name,
            phone,
            phone2,
            address,
            gst_number,
            pan,
            notes,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )
          ON CONFLICT (id) DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            phone2 = EXCLUDED.phone2,
            address = EXCLUDED.address,
            gst_number = EXCLUDED.gst_number,
            pan = EXCLUDED.pan,
            notes = EXCLUDED.notes,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at
          WHERE customers.shop_id = EXCLUDED.shop_id
          `,
          [
            id,
            shopId,
            String(customer.name),
            nullable(customer.phone),
            nullable(customer.phone2),
            customer.address == null
              ? ''
              : String(customer.address),
            nullable(customer.gstNumber),
            nullable(customer.pan),
            nullable(customer.notes),
            toDate(customer.createdAt),
            toDate(customer.updatedAt)
          ]
        );

        console.log(
          `  ✓ ${customer.name} [${customer.phone || 'no phone'}]`
        );

        shopMigrated++;
        totalCustomers++;
      }

      console.log(
        `  Migrated/processed: ${shopMigrated}`
      );
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('CUSTOMER MIGRATION COMPLETE');
    console.log(`Processed: ${totalCustomers}`);
    console.log('========================================');
  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch (_) {}

    console.error('\n========================================');
    console.error('CUSTOMER MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
