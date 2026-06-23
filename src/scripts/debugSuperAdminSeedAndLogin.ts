import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectMaster } from '../config/masterDb';
import { getSuperAdminModel } from '../models/master/SuperAdmin';



async function main() {
  const username = (process.env.SUPERADMIN_USERNAME || 'superadmin').toLowerCase().trim();
  const password = process.env.SUPERADMIN_PASSWORD || 'ChangeMe123!';

  console.log('[debug] SUPERADMIN_USERNAME=', username);
  console.log('[debug] SUPERADMIN_PASSWORD length=', String(password).length);

  const masterConn = await connectMaster();
  const SuperAdmin = getSuperAdminModel(masterConn);

  const admin = await SuperAdmin.findOne({ username });
  if (!admin) {
    console.error('[debug] No superadmin found for username:', username);
    process.exit(1);
  }

  console.log('[debug] Found superadmin id=', admin._id.toString());
  console.log('[debug] Found superadmin name=', admin.name);
  console.log('[debug] Password hash exists=', !!admin.passwordHash);

  const ok = await bcrypt.compare(password, admin.passwordHash);
  console.log('[debug] bcrypt.compare result=', ok);

  if (!ok) {
    console.error('[debug] Seeded password does NOT match stored passwordHash.');
    console.error('[debug] Check SUPERADMIN_PASSWORD in backend .env and re-run seed:superadmin');
    process.exit(1);
  }

  console.log('[debug] Password matches. Backend login should work.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


