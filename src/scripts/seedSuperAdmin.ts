import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectMaster } from '../config/masterDb';
import { getSuperAdminModel } from '../models/master/SuperAdmin';



async function seed() {
  const username = (process.env.SUPERADMIN_USERNAME || 'superadmin').toLowerCase().trim();
  const password = process.env.SUPERADMIN_PASSWORD || 'ChangeMe123!';
  const name = process.env.SUPERADMIN_NAME || 'Platform Owner';

  if (password.length < 8) {
    console.error('SUPERADMIN_PASSWORD should be at least 8 characters. Aborting.');
    process.exit(1);
  }

  const masterConn = await connectMaster();
  const SuperAdmin = getSuperAdminModel(masterConn);

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await SuperAdmin.findOne({ username });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.name = name;
    await existing.save();
    console.log(`✅ Super admin "${username}" already existed — password updated.`);
  } else {
    await SuperAdmin.create({ username, passwordHash, name });
    console.log(`✅ Super admin "${username}" created successfully.`);
  }

  console.log('\nYou can now log in to the Super Admin panel with:');
  console.log(`   Username: ${username}`);
  console.log(`   Password: ${password}`);
  console.log('\n⚠️  Change this password after first login, and never commit real credentials to .env in git.');

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
