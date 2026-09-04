require('dotenv').config();

const mongoose = require('mongoose');
const { Pool } = require('pg');

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

    let totalKarigars = 0;

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

      const karigars = await db.db.collection('karigars')
        .find({})
        .sort({ _id: 1 })
        .toArray();

      if (!karigars.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${karigars.length} karigars`
      );

      for (const karigar of karigars) {
        if (!karigar._id) {
          throw new Error(
            `Karigar without _id in ${shop.dbName}`
          );
        }

        if (!karigar.name) {
          throw new Error(
            `Karigar without name: ${JSON.stringify(karigar)}`
          );
        }

        const id = String(karigar._id);
        const name = String(karigar.name).trim();

        // mobile is NOT NULL in PostgreSQL
        const mobile =
          karigar.mobile !== undefined &&
          karigar.mobile !== null
            ? String(karigar.mobile)
            : '';

        const username =
          karigar.username !== undefined &&
          karigar.username !== null
            ? String(karigar.username)
            : null;

        const category =
          karigar.category !== undefined &&
          karigar.category !== null
            ? String(karigar.category)
            : null;

        const address =
          karigar.address !== undefined &&
          karigar.address !== null
            ? String(karigar.address)
            : null;

        const createdAt =
          karigar.createdAt
            ? new Date(karigar.createdAt)
            : new Date();

        const updatedAt =
          karigar.updatedAt
            ? new Date(karigar.updatedAt)
            : new Date();

        await pg.query(
          `
          INSERT INTO karigars (
            id,
            shop_id,
            name,
            mobile,
            company_name,
            email,
            category,
            specialty,
            gst_number,
            address,
            note,
            pending_weight,
            username,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            NULL,
            NULL,
            $5,
            NULL,
            NULL,
            $6,
            NULL,
            0,
            $7,
            $8,
            $9
          )
          ON CONFLICT (id)
          DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            name = EXCLUDED.name,
            mobile = EXCLUDED.mobile,
            category = EXCLUDED.category,
            address = EXCLUDED.address,
            username = EXCLUDED.username,
            updated_at = EXCLUDED.updated_at
          `,
          [
            id,
            shopId,
            name,
            mobile,
            category,
            address,
            username,
            createdAt,
            updatedAt
          ]
        );

        console.log(
          `  ✓ ${name} [${username || 'no username'}]`
        );

        totalKarigars++;
      }
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('KARIGAR MIGRATION COMPLETE');
    console.log(`Migrated: ${totalKarigars}`);
    console.log('========================================');

  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch (_) {}

    console.error('\n========================================');
    console.error('KARIGAR MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
