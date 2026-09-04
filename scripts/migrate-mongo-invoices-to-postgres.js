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

function numberValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function safePaymentMode(value) {
  const allowed = ['Cash', 'UPI', 'Card', 'EMI'];

  return allowed.includes(value) ? value : 'Cash';
}

function safeInvoiceType(value) {
  return value === 'GST' ? 'GST' : 'NON-GST';
}

function safeBillMetal(value) {
  return value === 'Silver' ? 'Silver' : 'Gold';
}

function safeOldMetalType(value) {
  const allowed = ['Gold', 'Silver', 'Mixed'];

  return allowed.includes(value) ? value : 'Gold';
}

function safeMakingChargeType(value) {
  const allowed = [
    'PERCENTAGE',
    'PER_GRAM',
    'FIXED',
    'PER_PIECE'
  ];

  return allowed.includes(value) ? value : 'FIXED';
}

function dateOnly(value) {
  const d = toDate(value);

  return d.toISOString().slice(0, 10);
}

async function main() {
  const mongo = await mongoose.createConnection(
    process.env.MONGODB_BASE_URI
  ).asPromise();

  const pg = new Pool({
    connectionString: process.env.DATABASE_URL
  });

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

  let totalInvoices = 0;
  let totalItems = 0;
  let totalPayments = 0;

  try {
    for (const shop of shops) {
      const db = mongo.useDb(shop.dbName, {
        useCache: false
      });

      const invoices = await db.db.collection('invoices')
        .find({})
        .sort({ createdAt: 1, _id: 1 })
        .toArray();

      if (!invoices.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${invoices.length} invoices`
      );

      const pgClient = await pg.connect();

      try {
        await pgClient.query('BEGIN');

        /*
         * Make sure this Mongo shop maps to exactly one PostgreSQL shop.
         */
        const shopResult = await pgClient.query(
          `
          SELECT id, slug
          FROM shops
          WHERE id = $1
          `,
          [String(shop._id)]
        );

        if (shopResult.rows.length !== 1) {
          throw new Error(
            `PostgreSQL shop not found: ${shop.slug} (${shop._id})`
          );
        }

        const shopId = shopResult.rows[0].id;

        for (const invoice of invoices) {
          if (!invoice._id || !invoice.number) {
            console.warn(
              `  ⚠ Skipping invoice without _id/number`
            );
            continue;
          }

          /*
           * Check whether this invoice has already been migrated.
           *
           * Invoice numbers can repeat across different shops,
           * therefore shop_id + number is used.
           */
          const existing = await pgClient.query(
            `
            SELECT id
            FROM invoices
            WHERE shop_id = $1
              AND number = $2
            LIMIT 1
            `,
            [
              shopId,
              String(invoice.number)
            ]
          );

          let invoiceId;

          if (existing.rows.length) {
            invoiceId = existing.rows[0].id;

            console.log(
              `  ↻ ${invoice.number} [already migrated: ${invoiceId}]`
            );
          } else {
            const invoiceResult = await pgClient.query(
              `
              INSERT INTO invoices (
                number,
                type,
                customer_id,
                customer_name,
                customer_mobile,
                discount,
                old_gold_amount,
                old_silver_amount,
                old_metal_type,
                bill_metal,
                payment_mode,
                subtotal,
                gst_amount,
                total,
                amount_paid,
                balance_due,
                customer_address,
                customer_signature,
                authorized_signatory,
                created_at,
                updated_at,
                shop_id
              )
              VALUES (
                $1,$2,$3,$4,$5,
                $6,$7,$8,$9,$10,
                $11,$12,$13,$14,$15,
                $16,$17,$18,$19,
                $20,$21,$22
              )
              RETURNING id
              `,
              [
                String(invoice.number),

                safeInvoiceType(invoice.type),

                nullable(invoice.customerId),
                String(invoice.customerName || 'Walk-in Customer'),
                nullable(invoice.customerMobile),

                numberValue(invoice.discount),
                numberValue(invoice.oldGoldAmount),
                numberValue(invoice.oldSilverAmount),

                safeOldMetalType(invoice.oldMetalType),

                safeBillMetal(invoice.billMetal),

                safePaymentMode(invoice.paymentMode),

                numberValue(invoice.subtotal),
                numberValue(invoice.gstAmount),
                numberValue(invoice.total),

                numberValue(invoice.amountPaid),
                numberValue(invoice.balanceDue),

                nullable(invoice.customerAddress),
                nullable(invoice.customerSignature),
                nullable(invoice.authorizedSignatory),

                toDate(invoice.createdAt),
                toDate(invoice.updatedAt),

                shopId
              ]
            );

            invoiceId = invoiceResult.rows[0].id;

            console.log(
              `  ✓ ${invoice.number} [${invoiceId}]`
            );

            totalInvoices++;
          }

          /*
           * IMPORTANT:
           * If invoice already exists, don't duplicate its children.
           */
          const existingItems = await pgClient.query(
            `
            SELECT COUNT(*)::int AS count
            FROM invoice_items
            WHERE invoice_id = $1
            `,
            [invoiceId]
          );

          const existingPayments = await pgClient.query(
            `
            SELECT COUNT(*)::int AS count
            FROM invoice_payments
            WHERE invoice_id = $1
            `,
            [invoiceId]
          );

          /*
           * Migrate invoice.items[]
           */
          if (
            Number(existingItems.rows[0].count) === 0 &&
            Array.isArray(invoice.items)
          ) {
            for (const item of invoice.items) {
              await pgClient.query(
                `
                INSERT INTO invoice_items (
                  invoice_id,
                  product_id,
                  name,
                  purity,
                  net_weight,
                  gross_weight,
                  stone_weight,
                  rate_per_gram,
                  making_charge,
                  making_charge_pct,
                  making_charge_type,
                  making_charge_value,
                  stone_charge,
                  gst_pct,
                  qty,
                  huid,
                  hmc
                )
                VALUES (
                  $1,$2,$3,$4,$5,
                  $6,$7,$8,$9,$10,
                  $11,$12,$13,$14,$15,
                  $16,$17
                )
                `,
                [
                  invoiceId,

                  String(
                    item.productId ||
                    `manual-${Date.now()}`
                  ),

                  String(item.name || 'Item'),

                  nullable(item.purity),

                  numberValue(item.netWeight),

                  numberValue(item.grossWeight),

                  numberValue(item.stoneWeight),

                  numberValue(item.ratePerGram),

                  numberValue(item.makingCharge),

                  numberValue(item.makingChargePct),

                  safeMakingChargeType(
                    item.makingChargeType
                  ),

                  numberValue(item.makingChargeValue),

                  numberValue(item.stoneCharge),

                  numberValue(item.gstPct),

                  numberValue(item.qty, 1),

                  nullable(item.huid),

                  numberValue(item.hmc)
                ]
              );

              totalItems++;
            }
          }

          /*
           * Migrate invoice.payments[]
           */
          if (
            Number(existingPayments.rows[0].count) === 0 &&
            Array.isArray(invoice.payments)
          ) {
            for (const payment of invoice.payments) {
              await pgClient.query(
                `
                INSERT INTO invoice_payments (
                  invoice_id,
                  payment_date,
                  amount,
                  mode,
                  note
                )
                VALUES ($1,$2,$3,$4,$5)
                `,
                [
                  invoiceId,

                  toDate(payment.date),

                  numberValue(payment.amount),

                  safePaymentMode(payment.mode),

                  nullable(payment.note)
                ]
              );

              totalPayments++;
            }
          }
        }

        await pgClient.query('COMMIT');
      } catch (error) {
        await pgClient.query('ROLLBACK');

        throw error;
      } finally {
        pgClient.release();
      }
    }

    console.log('\n========================================');
    console.log('INVOICE MIGRATION COMPLETE');
    console.log(`Migrated invoices: ${totalInvoices}`);
    console.log(`Migrated items: ${totalItems}`);
    console.log(`Migrated payments: ${totalPayments}`);
    console.log('========================================');

  } catch (error) {
    console.error('\n========================================');
    console.error('INVOICE MIGRATION FAILED');
    console.error('========================================');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
