const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Copy password decryption logic from backend/src/utils/passwordCrypto.ts if needed
// or just find the decrypted password from initialAdminUsername / initialOperatorUsername
// Let's check what fields are stored.

const uri = "mongodb+srv://cloudiefyy_db_user:Cloudiefy%409827@crm.nod44gh.mongodb.net/?appName=CRM";

function decryptPassword(encryptedHex) {
  try {
    const key = Buffer.from('a2ee3c45cf1889fd87d00ed5dad66cb288fcac8ffed721994bc2965198080986', 'hex');
    const textParts = encryptedHex.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) {
    return 'Decryption failed: ' + err.message;
  }
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('jewelshop_master');
    const shops = await db.collection('shops').find({}).toArray();
    console.log("=== SHOPS ===");
    for (const s of shops) {
      console.log(`ID: ${s._id}, Name: ${s.shopName}, Slug: ${s.slug}, DbName: ${s.dbName}`);
      console.log(`  Admin Username: ${s.initialAdminUsername}`);
      // Find the tenant users
      const tenantDb = client.db(s.dbName);
      const users = await tenantDb.collection('users').find({}).toArray();
      console.log("  Users in Tenant DB:");
      for (const u of users) {
        let decPass = '';
        if (u.passwordEncrypted) {
          decPass = decryptPassword(u.passwordEncrypted);
        }
        console.log(`    Username: ${u.username}, Role: ${u.role}, Name: ${u.name}, Decrypted Password: ${decPass}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();
