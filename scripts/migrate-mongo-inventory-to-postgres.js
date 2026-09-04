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

function integerValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const n = Number(value);

  return Number.isInteger(n) ? n : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Boolean(value);
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(
    value === undefined || value === null
      ? []
      : value
  );
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

    let totalInventory = 0;
    let totalStones = 0;
    let totalDiamonds = 0;

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

      const inventories = await db.db.collection('inventories')
        .find({})
        .sort({ _id: 1 })
        .toArray();

      if (!inventories.length) {
        continue;
      }

      console.log(
        `\n${shop.slug} (${shop.dbName}) -> ${inventories.length} inventory items`
      );

      for (const item of inventories) {
        if (!item._id || !item.name) {
          throw new Error(
            `Invalid inventory record in ${shop.slug}: ${JSON.stringify(item)}`
          );
        }

        /*
         * Mongo _id is NOT a PostgreSQL UUID.
         * PostgreSQL generates a new UUID here.
         */
        const existing = await pg.query(
          `
          SELECT id
          FROM inventory
          WHERE shop_id = $1
            AND barcode IS NOT DISTINCT FROM $2
            AND name = $3
            AND created_at = $4
          LIMIT 1
          `,
          [
            shopId,
            nullable(item.barcode),
            String(item.name),
            toDate(item.createdAt)
          ]
        );

        let inventoryId;

        if (existing.rowCount > 0) {
          inventoryId = existing.rows[0].id;

          console.log(
            `  ↻ ${item.name} [already migrated: ${inventoryId}]`
          );
        } else {
          const result = await pg.query(
            `
            INSERT INTO inventory (
              name,
              item_code,
              barcode,
              qr_code,
              sku,
              category,
              subcategory,
              brand,
              collection_name,
              product_type,
              design_no,
              model_no,
              note,
              metal_type,
              purity,
              huid,
              hallmark_certified,
              metal_color,
              gender,
              gross_weight,
              stone_weight,
              diamond_weight,
              other_weight,
              net_weight,
              purchase_rate,
              metal_rate,
              making_charge_type,
              making_charge,
              making_charge_pct,
              wastage_pct,
              stone_cost,
              diamond_cost,
              other_charges,
              cost_price,
              selling_price,
              min_selling_price,
              mrp,
              rate_per_gram,
              hsn_code,
              gst_pct,
              gst_type,
              stock,
              available_stock,
              reserved_stock,
              min_stock,
              max_stock,
              reorder_level,
              allow_negative_stock,
              branch,
              godown,
              rack,
              shelf,
              tray,
              locker,
              default_supplier_id,
              supplier_item_code,
              lead_time_days,
              is_manufactured,
              bom,
              labour_charge,
              casting_charge,
              polishing_charge,
              setting_charge,
              image_url,
              image_urls,
              certificate_pdf,
              status,
              last_purchase_price,
              last_selling_price,
              created_by,
              updated_by,
              created_at,
              updated_at,
              shop_id
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
              $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
              $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
              $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
              $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
              $61,$62,$63,$64,$65,$66,$67,$68,$69,$70,
              $71,$72,$73,$74
            )
            RETURNING id
            `,
            [
              String(item.name),
              nullable(item.itemCode),
              nullable(item.barcode),
              nullable(item.qrCode),
              nullable(item.sku),
              nullable(item.category) || 'Gold',
              nullable(item.subcategory),
              nullable(item.brand),
              nullable(item.collectionName),
              nullable(item.productType),
              nullable(item.designNo),
              nullable(item.modelNo),
              nullable(item.note),

              nullable(item.metalType) || 'Gold',
              nullable(item.purity) || '22K',
              nullable(item.huid),
              booleanValue(item.hallmarkCertified, true),
              nullable(item.metalColor) || 'Yellow',
              nullable(item.gender) || 'Unisex',

              numberValue(item.grossWeight),
              numberValue(item.stoneWeight),
              numberValue(item.diamondWeight),
              numberValue(item.otherWeight),
              numberValue(item.netWeight),

              numberValue(item.purchaseRate),
              numberValue(item.metalRate),

              nullable(item.makingChargeType) || 'fixed',
              numberValue(item.makingCharge),
              numberValue(item.makingChargePct),
              numberValue(item.wastagePct),

              numberValue(item.stoneCost),
              numberValue(item.diamondCost),
              numberValue(item.otherCharges),
              numberValue(item.costPrice),
              numberValue(item.sellingPrice),
              numberValue(item.minSellingPrice),
              numberValue(item.mrp),
              numberValue(item.ratePerGram),

              nullable(item.hsnCode) || '7113',
              numberValue(item.gstPct),
              nullable(item.gstType) || 'Exclusive',

              numberValue(item.stock),
              numberValue(item.availableStock),
              numberValue(item.reservedStock),
              numberValue(item.minStock),
              numberValue(item.maxStock),
              numberValue(item.reorderLevel),

              booleanValue(item.allowNegativeStock, false),

              nullable(item.branch) || 'Main Store',
              nullable(item.godown) || 'Main Vault',
              nullable(item.rack),
              nullable(item.shelf),
              nullable(item.tray),
              nullable(item.locker),

              nullable(item.defaultSupplierId),
              nullable(item.supplierItemCode),

              integerValue(item.leadTimeDays, 7),
              booleanValue(item.isManufactured, false),
              nullable(item.bom),

              numberValue(item.labourCharge),
              numberValue(item.castingCharge),
              numberValue(item.polishingCharge),
              numberValue(item.settingCharge),

              nullable(item.imageUrl),
              jsonValue(item.imageUrls),
              nullable(item.certificatePdf),

              nullable(item.status) || 'Active',
              numberValue(item.lastPurchasePrice),
              numberValue(item.lastSellingPrice),

              nullable(item.createdBy),
              nullable(item.updatedBy),

              toDate(item.createdAt),
              toDate(item.updatedAt),

              shopId
            ]
          );

          inventoryId = result.rows[0].id;

          console.log(
            `  ✓ ${item.name} [${inventoryId}]`
          );
        }

        /*
         * Mongo inventory.stones[]
         * Currently all 18 records have zero stones.
         * This remains here so future/other data is migrated correctly.
         */
        const stones = jsonArray(item.stones);

        for (const stone of stones) {
          await pg.query(
            `
            INSERT INTO inventory_stones (
              inventory_id,
              name,
              pcs,
              weight,
              rate,
              amount
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [
              inventoryId,
              String(stone.name || 'Stone'),
              numberValue(stone.pcs, 1),
              numberValue(stone.weight),
              numberValue(stone.rate),
              numberValue(stone.amount)
            ]
          );

          totalStones++;
        }

        /*
         * Mongo inventory.diamonds[]
         */
        const diamonds = jsonArray(item.diamonds);

        for (const diamond of diamonds) {
          await pg.query(
            `
            INSERT INTO inventory_diamonds (
              inventory_id,
              shape,
              color,
              clarity,
              weight,
              pcs,
              rate,
              cert_no,
              amount
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `,
            [
              inventoryId,
              nullable(diamond.shape) || 'Round',
              nullable(diamond.color) || 'G',
              nullable(diamond.clarity) || 'VS1',
              numberValue(diamond.weight),
              numberValue(diamond.pcs, 1),
              numberValue(diamond.rate),
              nullable(diamond.certNo),
              numberValue(diamond.amount)
            ]
          );

          totalDiamonds++;
        }

        totalInventory++;
      }
    }

    await pg.query('COMMIT');

    console.log('\n========================================');
    console.log('INVENTORY MIGRATION COMPLETE');
    console.log(`Migrated/processed: ${totalInventory}`);
    console.log(`Stones: ${totalStones}`);
    console.log(`Diamonds: ${totalDiamonds}`);
    console.log('========================================');
  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch (_) {}

    console.error('\n========================================');
    console.error('INVENTORY MIGRATION FAILED');
    console.error('========================================');
    console.error(error);

    process.exitCode = 1;
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main();
