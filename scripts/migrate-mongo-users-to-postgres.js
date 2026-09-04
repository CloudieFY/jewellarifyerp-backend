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

    let totalUsers = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);

      const db = mongo.useDb(shop.dbName, {
        useCache: false
      });

      const users = await db.db.collection('users')
        .find({})
        .toArray();

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${users.length} users`
      );

      for (const user of users) {
        if (!user._id || !user.username) {
          throw new Error(
            `Invalid user in ${shop.dbName}: ${JSON.stringify(user)}`
          );
        }

        const userId = String(user._id);

        const query = `
          INSERT INTO users (
            id,
            shop_id,
            username,
            password_hash,
            password_encrypted,
            name,
            role,
            karigar_ref_id,
            is_active,
            preferred_language,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12
          )
          ON CONFLICT (id)
          DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            username = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash,
            password_encrypted = EXCLUDED.password_encrypted,
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            karigar_ref_id = EXCLUDED.karigar_ref_id,
            is_active = EXCLUDED.is_active,
            preferred_language = EXCLUDED.preferred_language,
            updated_at = EXCLUDED.updated_at
        `;

        const values = [
          userId,
          shopId,
          user.username,
          user.passwordHash ?? '',
          user.passwordEncrypted ?? null,
          user.name ?? user.username,
          user.role ?? 'operator',
          user.karigarRefId
            ? String(user.karigarRefId)
            : null,
          user.isActive !== false,
          user.preferredLanguage ?? 'en',
          user.createdAt
            ? new Date(user.createdAt)
            : new Date(),
          user.updatedAt
            ? new Date(user.updatedAt)
            : new Date(),
        ];

        await pg.query(query, values);

        console.log(
          `  ✓ ${user.username} [${user.role}]`
        );

        totalUsers++;
      }
    }

    await pg.query('COMMIT');

    console.log('');
    console.log('========================================');
    console.log('USER MIGRATION COMPLETE');
    console.log(`Migrated: ${totalUsers}`);
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
  console.error('USER MIGRATION FAILED');
  console.error(error);
  process.exit(1);
});
