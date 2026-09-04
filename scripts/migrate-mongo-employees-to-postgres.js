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

function jsonPayments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value;
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

    let totalEmployees = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);

      // Verify PostgreSQL shop exists
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

      const employees = await db.db.collection('employees')
        .find({})
        .sort({ createdAt: 1 })
        .toArray();

      if (!employees.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${employees.length} employees`
      );

      let processed = 0;

      for (const employee of employees) {
        if (!employee._id) {
          throw new Error(
            `Employee without _id in ${shop.dbName}: ${JSON.stringify(employee)}`
          );
        }

        if (!employee.name) {
          throw new Error(
            `Employee without name in ${shop.dbName}: ${JSON.stringify(employee)}`
          );
        }

        if (!employee.role) {
          throw new Error(
            `Employee without role in ${shop.dbName}: ${JSON.stringify(employee)}`
          );
        }

        if (
          employee.joinDate === undefined ||
          employee.joinDate === null
        ) {
          throw new Error(
            `Employee without joinDate in ${shop.dbName}: ${JSON.stringify(employee)}`
          );
        }

        const id = String(employee._id);

        await pg.query(
          `
          INSERT INTO employees (
            id,
            shop_id,
            name,
            phone,
            role,
            salary,
            join_date,
            status,
            total_paid,
            notes,
            aadhaar,
            pan,
            bank_details,
            upi_id,
            address,
            payments,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15,
            $16::jsonb, $17, $18
          )
          ON CONFLICT (id) DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            role = EXCLUDED.role,
            salary = EXCLUDED.salary,
            join_date = EXCLUDED.join_date,
            status = EXCLUDED.status,
            total_paid = EXCLUDED.total_paid,
            notes = EXCLUDED.notes,
            aadhaar = EXCLUDED.aadhaar,
            pan = EXCLUDED.pan,
            bank_details = EXCLUDED.bank_details,
            upi_id = EXCLUDED.upi_id,
            address = EXCLUDED.address,
            payments = EXCLUDED.payments,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at
          `,
          [
            id,
            shopId,
            String(employee.name),
            nullable(employee.phone),
            String(employee.role),
            numberValue(employee.salary),
            String(employee.joinDate),
            employee.status
              ? String(employee.status)
              : 'Active',
            numberValue(employee.totalPaid),
            nullable(employee.notes),
            nullable(employee.aadhaar),
            nullable(employee.pan),
            nullable(employee.bankDetails),
            nullable(employee.upiId),
            nullable(employee.address),
            JSON.stringify(jsonPayments(employee.payments)),
            toDate(employee.createdAt),
            toDate(employee.updatedAt)
          ]
        );

        processed++;
        totalEmployees++;

        console.log(
          `  ✓ ${employee.name} [${employee.role}]`
        );
      }

      console.log(
        `  Migrated/processed: ${processed}`
      );
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('EMPLOYEE MIGRATION COMPLETE');
    console.log(`Processed: ${totalEmployees}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');

    console.error('\n========================================');
    console.error('EMPLOYEE MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
