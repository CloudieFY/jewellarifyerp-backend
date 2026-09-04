require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

function toDate(value) {
  if (!value) return new Date();

  const d = new Date(value);

  return Number.isNaN(d.getTime())
    ? new Date()
    : d;
}

function nullable(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return String(value);
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
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

    let totalSuppliers = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);

      // Verify corresponding PostgreSQL shop exists
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

      const suppliers = await db.db.collection('suppliers')
        .find({})
        .sort({ createdAt: 1 })
        .toArray();

      if (!suppliers.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${suppliers.length} suppliers`
      );

      let processed = 0;

      for (const supplier of suppliers) {
        if (!supplier._id) {
          throw new Error(
            `Supplier without _id in ${shop.dbName}: ${JSON.stringify(supplier)}`
          );
        }

        if (!supplier.name) {
          throw new Error(
            `Supplier without name in ${shop.dbName}: ${JSON.stringify(supplier)}`
          );
        }

        if (
          supplier.mobile === undefined ||
          supplier.mobile === null
        ) {
          throw new Error(
            `Supplier without mobile in ${shop.dbName}: ${JSON.stringify(supplier)}`
          );
        }

        const id = String(supplier._id);

        await pg.query(
          `
          INSERT INTO suppliers (
            id,
            shop_id,
            name,
            company,
            mobile,
            email,
            category,
            gst_number,
            address,
            company_no,
            note,
            outstanding,
            balance_gold,
            balance_silver,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16
          )
          ON CONFLICT (id) DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            name = EXCLUDED.name,
            company = EXCLUDED.company,
            mobile = EXCLUDED.mobile,
            email = EXCLUDED.email,
            category = EXCLUDED.category,
            gst_number = EXCLUDED.gst_number,
            address = EXCLUDED.address,
            company_no = EXCLUDED.company_no,
            note = EXCLUDED.note,
            outstanding = EXCLUDED.outstanding,
            balance_gold = EXCLUDED.balance_gold,
            balance_silver = EXCLUDED.balance_silver,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at
          `,
          [
            id,
            shopId,
            String(supplier.name),
            nullable(
              supplier.company ??
              supplier.companyName
            ),
            String(supplier.mobile),
            nullable(supplier.email),
            nullable(supplier.category),
            nullable(
              supplier.gstNumber ??
              supplier.gst_number
            ),
            nullable(supplier.address),
            nullable(
              supplier.companyNo ??
              supplier.company_no
            ),
            nullable(
              supplier.note ??
              supplier.notes
            ),
            numberValue(
              supplier.outstanding
            ),
            numberValue(
              supplier.balanceGold ??
              supplier.balance_gold
            ),
            numberValue(
              supplier.balanceSilver ??
              supplier.balance_silver
            ),
            toDate(supplier.createdAt),
            toDate(supplier.updatedAt)
          ]
        );

        processed++;
        totalSuppliers++;

        console.log(
          `  ✓ ${supplier.name} [${supplier.mobile || 'no mobile'}]`
        );
      }

      console.log(
        `  Migrated/processed: ${processed}`
      );
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('SUPPLIER MIGRATION COMPLETE');
    console.log(`Processed: ${totalSuppliers}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');

    console.error('\n========================================');
    console.error('SUPPLIER MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
