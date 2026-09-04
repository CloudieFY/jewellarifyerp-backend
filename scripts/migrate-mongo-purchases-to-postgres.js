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

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Boolean(value);
}

/*
 * Migrate a Mongo purchase's embedded `items[]` array into the
 * `purchase_items` child table (created in migration 007). Idempotent: if the
 * purchase already has child rows, this does nothing, so it also serves as a
 * backfill for purchases migrated before the child table existed.
 */
async function migratePurchaseItems(pg, purchaseId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  const existing = await pg.query(
    `SELECT 1 FROM purchase_items WHERE purchase_id = $1 LIMIT 1`,
    [purchaseId]
  );
  if (existing.rowCount) return 0;

  let migrated = 0;
  for (const it of items) {
    const makingChargeType = ['per_gram', 'percentage', 'fixed'].includes(it.makingChargeType)
      ? it.makingChargeType
      : 'fixed';

    await pg.query(
      `
      INSERT INTO purchase_items (
        purchase_id, name, category, metal, purity, huid, barcode, pcs,
        gross_weight, less_weight, net_weight, hmc, rate_per_gram,
        making_charge_type, making_charge, making_charge_pct, total, hsn_code, note
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `,
      [
        purchaseId,
        nullable(it.name) || 'Jewellery Item',
        nullable(it.category) || 'Gold',
        nullable(it.metal) || 'Gold',
        nullable(it.purity) || '22K',
        nullable(it.huid),
        nullable(it.barcode),
        it.pcs === undefined || it.pcs === null ? 1 : numberValue(it.pcs),
        numberValue(it.grossWeight),
        numberValue(it.lessWeight),
        numberValue(it.netWeight),
        numberValue(it.hmc),
        numberValue(it.ratePerGram),
        makingChargeType,
        numberValue(it.makingCharge),
        numberValue(it.makingChargePct),
        numberValue(it.total),
        nullable(it.hsnCode),
        nullable(it.note),
      ]
    );
    migrated += 1;
  }
  return migrated;
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

    let totalPurchases = 0;
    let totalItems = 0;

    for (const shop of shops) {
      const shopId = String(shop._id);

      const shopCheck = await pg.query(
        `SELECT id FROM shops WHERE id = $1`,
        [shopId]
      );

      if (!shopCheck.rowCount) {
        console.log(
          `\n⚠ Skipping ${shop.slug}: PostgreSQL shop not found`
        );
        continue;
      }

      const db = mongo.useDb(shop.dbName, {
        useCache: false
      });

      const purchases = await db.db.collection('purchases')
        .find({})
        .sort({ date: 1, createdAt: 1 })
        .toArray();

      if (!purchases.length) continue;

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${purchases.length} purchases`
      );

      for (const purchase of purchases) {
        if (!purchase._id || !purchase.billNo) {
          console.log(
            `  ⚠ Skipping purchase with missing _id/billNo`
          );
          continue;
        }

        const mongoId = String(purchase._id);
        const billNo = String(purchase.billNo);

        // Check whether this Mongo purchase was already migrated.
        // linked_doc_id stores the original Mongo _id.
        const existing = await pg.query(
          `
          SELECT id
          FROM purchases
          WHERE shop_id = $1
            AND (
              linked_doc_id = $2
              OR bill_no = $3
            )
          LIMIT 1
          `,
          [
            shopId,
            mongoId,
            billNo
          ]
        );

        if (existing.rowCount) {
          const backfilled = await migratePurchaseItems(
            pg,
            existing.rows[0].id,
            purchase.items
          );
          totalItems += backfilled;
          console.log(
            `  ↻ ${billNo} [already migrated: ${existing.rows[0].id}]` +
              (backfilled ? ` (+${backfilled} items backfilled)` : '')
          );
          totalPurchases++;
          continue;
        }

        /*
         * Verify supplier belongs to the same shop.
         * If supplier is missing, preserve supplier_id/name from Mongo
         * but do not invent a PostgreSQL supplier.
         */
        let supplierId = nullable(purchase.supplierId);

        if (supplierId) {
          const supplierCheck = await pg.query(
            `
            SELECT id
            FROM suppliers
            WHERE id = $1
              AND shop_id = $2
            LIMIT 1
            `,
            [
              supplierId,
              shopId
            ]
          );

          if (!supplierCheck.rowCount) {
            console.log(
              `  ⚠ ${billNo}: supplier ${supplierId} not found for shop`
            );
          }
        }

        const result = await pg.query(
          `
          INSERT INTO purchases (
            bill_no,
            date,
            supplier_id,
            supplier_name,
            supplier_gstin,
            metal,
            purity,
            hsn_code,
            weight,
            rate_per_gram,
            making_charge,
            taxable_value,
            gst_pct,
            cgst,
            sgst,
            igst,
            total,
            payment_mode,
            note,
            doc_type,
            category,
            status,
            needs_approval,
            approved_by,
            approved_at,
            rejection_reason,
            linked_doc_id,
            customer_id,
            customer_name,
            deduction_pct,
            created_at,
            updated_at,
            shop_id
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
            $31,$32,$33
          )
          RETURNING id
          `,
          [
            billNo,
            purchase.date
              ? String(purchase.date).slice(0, 10)
              : new Date().toISOString().slice(0, 10),

            supplierId,

            nullable(purchase.supplierName),
            nullable(purchase.supplierGstin),

            nullable(purchase.metal) || 'Gold',
            nullable(purchase.purity),
            nullable(purchase.hsnCode),

            numberValue(purchase.weight),
            numberValue(purchase.ratePerGram),
            numberValue(purchase.makingCharge),

            numberValue(purchase.taxableValue),
            numberValue(purchase.gstPct),
            numberValue(purchase.cgst),
            numberValue(purchase.sgst),
            numberValue(purchase.igst),

            numberValue(purchase.total),

            nullable(purchase.paymentMode) || 'Cash',
            nullable(purchase.note),

            nullable(purchase.docType) || 'Entry',
            nullable(purchase.category) || 'Metal',
            nullable(purchase.status) || 'Completed',

            booleanValue(purchase.needsApproval, false),

            nullable(purchase.approvedBy),
            purchase.approvedAt
              ? toDate(purchase.approvedAt)
              : null,

            nullable(purchase.rejectionReason),

            // Preserve original Mongo purchase ID.
            mongoId,

            nullable(purchase.customerId),
            nullable(purchase.customerName),
            numberValue(purchase.deductionPct),

            toDate(purchase.createdAt),
            toDate(purchase.updatedAt),

            shopId
          ]
        );

        const itemCount = await migratePurchaseItems(
          pg,
          result.rows[0].id,
          purchase.items
        );
        totalItems += itemCount;

        console.log(
          `  ✓ ${billNo} [${result.rows[0].id}]` +
            (itemCount ? ` (${itemCount} items)` : '')
        );

        totalPurchases++;
      }
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('PURCHASE MIGRATION COMPLETE');
    console.log(`Migrated/processed: ${totalPurchases}`);
    console.log(`Line items migrated: ${totalItems}`);
    console.log('========================================');
  } catch (error) {
    await pg.query('ROLLBACK');

    console.error('\n========================================');
    console.error('PURCHASE MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
