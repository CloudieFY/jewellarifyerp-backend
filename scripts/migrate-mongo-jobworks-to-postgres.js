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

    let totalJobworks = 0;

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

      const jobworks = await db.db.collection('jobworks')
        .find({})
        .sort({ _id: 1 })
        .toArray();

      if (!jobworks.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${jobworks.length} jobworks`
      );

      for (const jobwork of jobworks) {
        if (!jobwork.jobNo) {
          throw new Error(
            `Jobwork without jobNo in ${shop.dbName}`
          );
        }

        if (!jobwork.date) {
          throw new Error(
            `Jobwork without date: ${jobwork.jobNo}`
          );
        }

        if (!jobwork.karigarId) {
          throw new Error(
            `Jobwork without karigarId: ${jobwork.jobNo}`
          );
        }

        const karigarId = String(jobwork.karigarId);

        // Verify karigar belongs to same shop
        const karigarCheck = await pg.query(
          `
          SELECT id, name
          FROM karigars
          WHERE id = $1
            AND shop_id = $2
          `,
          [karigarId, shopId]
        );

        if (karigarCheck.rowCount !== 1) {
          throw new Error(
            `Karigar not found for jobwork ${jobwork.jobNo}: ` +
            `${karigarId} in shop ${shop.slug}`
          );
        }

        const karigar = karigarCheck.rows[0];

        const jobNo = String(jobwork.jobNo);

        const date = new Date(jobwork.date);

        const karigarName =
          jobwork.karigarName !== undefined &&
          jobwork.karigarName !== null
            ? String(jobwork.karigarName).trim()
            : String(karigar.name).trim();

        const itemDescription =
          jobwork.itemDescription !== undefined &&
          jobwork.itemDescription !== null
            ? String(jobwork.itemDescription)
            : '';

        const metal =
          jobwork.metal !== undefined &&
          jobwork.metal !== null
            ? String(jobwork.metal)
            : 'Gold';

        const purity =
          jobwork.purity !== undefined &&
          jobwork.purity !== null
            ? String(jobwork.purity)
            : '22K';

        const issuedWeight = Number(
          jobwork.issuedWeight || 0
        );

        const receivedWeight = Number(
          jobwork.receivedWeight || 0
        );

        const wastage = Number(
          jobwork.wastage || 0
        );

        const makingCharge = Number(
          jobwork.makingCharge || 0
        );

        const dueDate =
          jobwork.dueDate
            ? new Date(jobwork.dueDate)
            : null;

        const allowedStatuses = [
          'Issued',
          'In Progress',
          'Received',
          'Settled'
        ];

        const status =
          allowedStatuses.includes(jobwork.status)
            ? jobwork.status
            : 'Issued';

        const note =
          jobwork.note !== undefined &&
          jobwork.note !== null
            ? String(jobwork.note)
            : null;

        const createdAt =
          jobwork.createdAt
            ? new Date(jobwork.createdAt)
            : new Date();

        const updatedAt =
          jobwork.updatedAt
            ? new Date(jobwork.updatedAt)
            : new Date();

        await pg.query(
          `
          INSERT INTO jobworks (
            shop_id,
            job_no,
            date,
            karigar_id,
            karigar_name,
            item_description,
            metal,
            purity,
            issued_weight,
            received_weight,
            wastage,
            making_charge,
            due_date,
            status,
            note,
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
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17
          )
          ON CONFLICT (shop_id, job_no)
          DO UPDATE SET
            date = EXCLUDED.date,
            karigar_id = EXCLUDED.karigar_id,
            karigar_name = EXCLUDED.karigar_name,
            item_description = EXCLUDED.item_description,
            metal = EXCLUDED.metal,
            purity = EXCLUDED.purity,
            issued_weight = EXCLUDED.issued_weight,
            received_weight = EXCLUDED.received_weight,
            wastage = EXCLUDED.wastage,
            making_charge = EXCLUDED.making_charge,
            due_date = EXCLUDED.due_date,
            status = EXCLUDED.status,
            note = EXCLUDED.note,
            updated_at = EXCLUDED.updated_at
          `,
          [
            shopId,
            jobNo,
            date,
            karigarId,
            karigarName,
            itemDescription,
            metal,
            purity,
            issuedWeight,
            receivedWeight,
            wastage,
            makingCharge,
            dueDate,
            status,
            note,
            createdAt,
            updatedAt
          ]
        );

        console.log(
          `  ✓ ${jobNo} [${karigarName}]`
        );

        totalJobworks++;
      }
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('JOBWORK MIGRATION COMPLETE');
    console.log(`Migrated: ${totalJobworks}`);
    console.log('========================================');

  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch (_) {}

    console.error('\n========================================');
    console.error('JOBWORK MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
