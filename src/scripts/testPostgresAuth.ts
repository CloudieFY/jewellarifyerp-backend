import 'dotenv/config';
import bcrypt from 'bcryptjs';

import { connectPostgres, pgPool } from '../config/postgres';
import {
  createSuperAdmin,
  findSuperAdminByUsername,
} from '../repositories/superAdminRepository';

import {
  createShop,
  findShopBySlug,
} from '../repositories/shopRepository';

import {
  createUser,
  findUserByUsername,
} from '../repositories/userRepository';

async function main() {
  await connectPostgres();

  const username = 'postgres_test_admin';
  const password = 'Test@12345';

  try {
    let admin = await findSuperAdminByUsername(username);

    if (!admin) {
      const passwordHash = await bcrypt.hash(password, 10);

      admin = await createSuperAdmin({
        username,
        passwordHash,
        name: 'PostgreSQL Test Admin',
      });
    }

    console.log('SuperAdmin:', {
      id: admin.id,
      username: admin.username,
      name: admin.name,
    });

    const shopSlug = 'postgres-test-shop';

    let shop = await findShopBySlug(shopSlug);

    if (!shop) {
      shop = await createShop({
        slug: shopSlug,
        shopName: 'PostgreSQL Test Shop',
        ownerName: 'Test Owner',
        plan: 'trial',
        subscriptionStartDate: new Date(),
        subscriptionEndDate: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ),
        initialAdminUsername: 'testowner',
        initialOperatorUsername: 'testoperator',
        legacyDbName: 'legacy_test_db',
      });
    }

    console.log('Shop:', {
      id: shop.id,
      slug: shop.slug,
      shopName: shop.shop_name,
    });

    let user = await findUserByUsername(shop.id, 'testowner');

    if (!user) {
      const passwordHash = await bcrypt.hash('Owner@12345', 10);

      user = await createUser({
        shopId: shop.id,
        username: 'testowner',
        passwordHash,
        name: 'Test Owner',
        role: 'owner',
      });
    }

    console.log('Tenant User:', {
      id: user.id,
      shopId: user.shop_id,
      username: user.username,
      role: user.role,
    });

    const passwordOK = await bcrypt.compare(
      'Owner@12345',
      user.password_hash
    );

    console.log('Password verification:', passwordOK);

    const wrongPassword = await bcrypt.compare(
      'wrong-password',
      user.password_hash
    );

    console.log('Wrong password rejected:', !wrongPassword);

    console.log('\n✅ PostgreSQL auth repositories are working.');
  } finally {
    await pgPool.end();
  }
}

main().catch((error) => {
  console.error('\n❌ PostgreSQL auth test failed:', error);
  process.exit(1);
});
