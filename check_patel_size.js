const mongoose = require('mongoose');

const uri = "mongodb+srv://cloudiefyy_db_user:Cloudiefy%409827@crm.nod44gh.mongodb.net/jewelshop_master?appName=CRM";

async function run() {
  try {
    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    const shop = await db.collection('shops').findOne({ slug: 'patel' });
    if (!shop) {
      console.log("Shop 'patel' not found.");
      return;
    }

    console.log("=== Shop Patel Details ===");
    console.log(`shopName: ${shop.shopName}`);
    console.log(`logoUrl length: ${shop.logoUrl ? shop.logoUrl.length : 0}`);
    if (shop.logoUrl) {
      console.log(`logoUrl prefix: ${shop.logoUrl.substring(0, 100)}`);
    }

    const settings = shop.invoiceSettings || {};
    console.log(`invoiceSettings keys:`, Object.keys(settings));
    console.log(`qrCodeUrl length: ${settings.qrCodeUrl ? settings.qrCodeUrl.length : 0}`);
    if (settings.qrCodeUrl) {
      console.log(`qrCodeUrl prefix: ${settings.qrCodeUrl.substring(0, 100)}`);
    }

    // Estimate total BSON size of the document
    const buffer = require('bson').serialize(shop);
    console.log(`Total BSON size of the document: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
