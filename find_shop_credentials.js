const mongoose = require('mongoose');
const crypto = require('crypto');

const uri = "mongodb+srv://cloudiefyy_db_user:Cloudiefy%409827@crm.nod44gh.mongodb.net/jewelshop_master?appName=CRM";

function decryptPassword(payload) {
  try {
    const key = Buffer.from('a2ee3c45cf1889fd87d00ed5dad66cb288fcac8ffed721994bc2965198080986', 'hex');
    const [ivHex, authTagHex, dataHex] = payload.split(':');
    if (!ivHex || !authTagHex || !dataHex) {
      return 'Malformed encrypted password';
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    return 'Decryption failed: ' + err.message;
  }
}

async function run() {
  try {
    await mongoose.connect(uri);
    console.log("Connected to master DB.");
    const db = mongoose.connection.db;
    const shops = await db.collection('shops').find({}).toArray();
    console.log("=== SHOPS ===");
    for (const s of shops) {
      console.log(`ID: ${s._id}, Name: ${s.shopName}, Slug: ${s.slug}, DbName: ${s.dbName}`);
      console.log(`  Admin Username: ${s.initialAdminUsername}`);
      
      // Query tenant database
      const tenantConn = await mongoose.createConnection(
        `mongodb+srv://cloudiefyy_db_user:Cloudiefy%409827@crm.nod44gh.mongodb.net/${s.dbName}?appName=CRM`
      ).asPromise();
      
      const users = await tenantConn.db.collection('users').find({}).toArray();
      console.log("  Users in Tenant DB:");
      for (const u of users) {
        let decPass = '';
        if (u.passwordEncrypted) {
          decPass = decryptPassword(u.passwordEncrypted);
        }
        console.log(`    Username: ${u.username}, Role: ${u.role}, Name: ${u.name}, Decrypted Password: ${decPass}`);
      }
      await tenantConn.close();
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
