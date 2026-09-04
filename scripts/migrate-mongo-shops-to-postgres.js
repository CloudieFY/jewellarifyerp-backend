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
    const mongoDb = mongo.useDb(
      process.env.MASTER_DB_NAME || 'jewelshop_master',
      { useCache: false }
    );

    const shops = await mongoDb.db.collection('shops')
      .find({})
      .sort({ dbName: 1 })
      .toArray();

    console.log(`Found ${shops.length} Mongo shops.`);

    await pg.query('BEGIN');

    for (const shop of shops) {
      if (!shop._id || !shop.slug || !shop.dbName) {
        throw new Error(
          `Invalid shop record: ${JSON.stringify(shop)}`
        );
      }

      const id = String(shop._id);

      const query = `
        INSERT INTO shops (
          id,
          slug,
          shop_name,
          owner_name,
          email,
          phone,
          logo_url,
          address,
          gst_number,
          number_of_shop_owner,
          plan,
          status,
          subscription_start_date,
          subscription_end_date,
          initial_admin_username,
          initial_operator_username,
          legacy_db_name,
          notes
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (id)
        DO UPDATE SET
          slug = EXCLUDED.slug,
          shop_name = EXCLUDED.shop_name,
          owner_name = EXCLUDED.owner_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          logo_url = EXCLUDED.logo_url,
          address = EXCLUDED.address,
          gst_number = EXCLUDED.gst_number,
          number_of_shop_owner = EXCLUDED.number_of_shop_owner,
          plan = EXCLUDED.plan,
          status = EXCLUDED.status,
          subscription_start_date = EXCLUDED.subscription_start_date,
          subscription_end_date = EXCLUDED.subscription_end_date,
          initial_admin_username = EXCLUDED.initial_admin_username,
          initial_operator_username = EXCLUDED.initial_operator_username,
          legacy_db_name = EXCLUDED.legacy_db_name,
          updated_at = NOW()
        RETURNING id, slug, shop_name, legacy_db_name
      `;

      const values = [
        id,
        shop.slug,
        shop.shopName ?? null,
        shop.ownerName ?? null,
        shop.email ?? null,
        shop.phone ?? null,
        shop.logoUrl ?? null,
        shop.address ?? null,
        shop.gstNumber ?? null,
        shop.numberOfShopOwner ?? null,
        shop.plan ?? 'trial',
        shop.status ?? 'active',
        shop.subscriptionStartDate
          ? new Date(shop.subscriptionStartDate)
          : new Date(),
        shop.subscriptionEndDate
          ? new Date(shop.subscriptionEndDate)
          : new Date(),
        shop.initialAdminUsername ?? null,
        shop.initialOperatorUsername ?? null,
        shop.dbName,
        shop.notes ?? null,
      ];

      const result = await pg.query(query, values);

      console.log(
        `✓ ${result.rows[0].slug} -> ${result.rows[0].legacy_db_name}`
      );
    }

    await pg.query('COMMIT');

    console.log('');
    console.log('========================================');
    console.log('SHOP MIGRATION COMPLETE');
    console.log(`Migrated: ${shops.length}`);
    console.log('========================================');

  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main().catch((error) => {
  console.error('');
  console.error('MIGRATION FAILED');
  console.error(error);
  process.exit(1);
});
