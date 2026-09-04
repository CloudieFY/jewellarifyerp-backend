import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pgPool } from '../config/postgres';
import { generateId } from '../utils/id';
import { signSuperAdminToken } from '../utils/jwt';
import { requireSuperAdminPg } from '../middleware/authPg';
import { encryptPassword, decryptPassword } from '../utils/passwordCrypto';
import { rowToApi } from '../db/mapping';
import {
  findSuperAdminByUsername,
  findSuperAdminById,
} from '../repositories/superAdminRepository';
import {
  findShopBySlug,
  findShopById,
  listShops,
  createShop,
  updateShop,
  updateShopSlug,
  updateShopStatus,
  deleteShop,
} from '../repositories/shopRepository';
import {
  findUserByUsername,
  createUser,
  updateUserPasswordByUsername,
} from '../repositories/userRepository';

/**
 * PostgreSQL port of `routes/superAdmin.ts` (mounted at `/api/superadmin`).
 *
 * The platform control plane. The big difference from the Mongo version:
 * there is no per-tenant database to provision. Creating a shop is now just
 * inserting the `shops` row plus its two seed `users` (owner + operator) and
 * an empty `gold_rates` row — all in the one Postgres DB, scoped by `shop_id`.
 * `getTenantContext` / `dbNameForShop` / `closeTenantConnection` are gone.
 */

const router = Router();

/* ---------------------------------------------------------------------- */
/*  AUTH (public)                                                          */
/* ---------------------------------------------------------------------- */

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const normalizedUsername = String(username).toLowerCase().trim();
    console.log('[SuperAdmin/pg login] attempt:', { normalizedUsername });

    const admin = await findSuperAdminByUsername(normalizedUsername);
    if (!admin) {
      console.log('[SuperAdmin/pg login] no superadmin for username:', { normalizedUsername });
      return res.status(401).json({ error: 'User not found' });
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      console.log('[SuperAdmin/pg login] password mismatch for username:', { normalizedUsername });
      return res.status(401).json({ error: 'User not found' });
    }

    const token = signSuperAdminToken({ sub: admin.id, username: admin.username });
    res.json({
      token,
      admin: { id: admin.id, username: admin.username, name: admin.name || admin.username },
    });
  } catch (error: any) {
    console.error('[SuperAdmin/pg login] error:', error?.message || error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// Create a new demo request / support ticket (public)
router.post('/demo-requests', async (req: Request, res: Response) => {
  try {
    const { name, shopName, phone, email, address, message } = req.body;
    if (!name || !shopName || !phone) {
      return res.status(400).json({ error: 'Name, shop name, and phone are required' });
    }

    const { rows } = await pgPool.query(
      `INSERT INTO demo_requests (id, name, shop_name, phone, email, address, message, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending')
       RETURNING *`,
      [generateId('demo'), name, shopName, phone, email ?? null, address ?? null, message ?? null]
    );

    console.log('\n🔔 ========== NEW SUPPORT TICKET ==========');
    console.log(`👤 Name:    ${name}`);
    console.log(`🏪 Shop:    ${shopName}`);
    console.log(`📱 Phone:   ${phone}`);
    if (email) console.log(`📧 Email:   ${email}`);
    if (message) console.log(`📝 Message: ${message}`);
    console.log(`🕐 Time:    ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log('==========================================\n');

    res.status(201).json(rowToApi(rows[0]));
  } catch (error: any) {
    console.error('[Demo Request/pg] create error:', error?.message || error);
    res.status(500).json({ error: 'Failed to submit demo request.' });
  }
});

/* ---------------------------------------------------------------------- */
/*  Everything below requires a valid super-admin token                   */
/* ---------------------------------------------------------------------- */

router.get('/me', requireSuperAdminPg, async (req: Request, res: Response) => {
  try {
    const admin = await findSuperAdminById(req.superAdmin!.sub);
    if (!admin) return res.status(404).json({ error: 'Not found' });
    const obj = rowToApi<any>(admin)!;
    delete obj.passwordHash;
    res.json(obj);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load profile' });
  }
});

router.use(requireSuperAdminPg);

/* ------------------------------ demo requests ------------------------- */

router.get('/demo-requests', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM demo_requests ORDER BY created_at DESC`
    );
    res.json(rows.map((r) => rowToApi(r)));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch demo requests' });
  }
});

router.put('/demo-requests/:id', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    const { rows } = await pgPool.query(
      `UPDATE demo_requests SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    res.json(rowToApi(rows[0]));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to update demo request' });
  }
});

router.delete('/demo-requests/:id', async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pgPool.query(`DELETE FROM demo_requests WHERE id = $1`, [
      req.params.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ error: 'Request not found' });
    res.json({ message: 'Demo request deleted successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to delete demo request' });
  }
});

/* ------------------------------ shops -------------------------------- */

// List all shops, augmented with a live user count.
router.get('/shops', async (_req: Request, res: Response) => {
  try {
    const shops = await listShops();
    const { rows: counts } = await pgPool.query(
      `SELECT shop_id, COUNT(*)::int AS n FROM users GROUP BY shop_id`
    );
    const countByShop = new Map<string, number>(counts.map((r: any) => [r.shop_id, r.n]));

    res.json(
      shops.map((shop) => {
        const obj = rowToApi<any>(shop)!;
        obj.userCount = countByShop.get(shop.id) ?? 0;
        return obj;
      })
    );
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch shops' });
  }
});

router.get('/shops/:id', async (req: Request, res: Response) => {
  try {
    const shop = await findShopById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(rowToApi(shop));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch shop' });
  }
});

/**
 * Create a new shop (SaaS onboarding).
 *  1. Insert the `shops` row.
 *  2. Seed its two logins (GST owner + Non-GST operator) and an empty
 *     `gold_rates` row, all scoped by `shop_id`.
 *  3. If step 2 fails, delete the shop row so the slug isn't left stuck.
 */
router.post('/shops', async (req: Request, res: Response) => {
  try {
    const {
      slug,
      shopName,
      ownerName,
      email,
      phone,
      logoUrl,
      address,
      gstNumber,
      plan,
      subscriptionEndDate,
      gstAdminUsername,
      gstAdminPassword,
      nonGstAdminUsername,
      nonGstAdminPassword,
      notes,
    } = req.body;

    if (
      !slug ||
      !shopName ||
      !gstAdminUsername ||
      !gstAdminPassword ||
      !nonGstAdminUsername ||
      !nonGstAdminPassword
    ) {
      return res
        .status(400)
        .json({ error: 'slug, shopName, and both sets of admin credentials are required' });
    }
    if (String(gstAdminPassword).length < 6 || String(nonGstAdminPassword).length < 6) {
      return res.status(400).json({ error: 'All admin passwords must be at least 6 characters' });
    }

    const normalizedGstUsername = String(gstAdminUsername).toLowerCase().trim();
    const normalizedNonGstUsername = String(nonGstAdminUsername).toLowerCase().trim();
    if (normalizedGstUsername === normalizedNonGstUsername) {
      return res
        .status(400)
        .json({ error: 'GST Owner and Non-GST Operator usernames must be different' });
    }

    const normalizedSlug = String(slug).toLowerCase().trim().replace(/\s+/g, '-');
    const existing = await findShopBySlug(normalizedSlug);
    if (existing) {
      return res.status(409).json({ error: `Shop id "${normalizedSlug}" is already taken` });
    }

    const endDate = subscriptionEndDate
      ? new Date(subscriptionEndDate)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // default 30-day trial

    const shop = await createShop({
      slug: normalizedSlug,
      shopName,
      ownerName,
      email,
      phone,
      logoUrl,
      address,
      gstNumber,
      plan: plan || 'trial',
      subscriptionStartDate: new Date(),
      subscriptionEndDate: endDate,
      initialAdminUsername: normalizedGstUsername,
      initialOperatorUsername: normalizedNonGstUsername,
      notes,
    });

    try {
      const gstPasswordHash = await bcrypt.hash(gstAdminPassword, 10);
      await createUser({
        shopId: shop.id,
        username: normalizedGstUsername,
        passwordHash: gstPasswordHash,
        passwordEncrypted: encryptPassword(gstAdminPassword),
        name: ownerName || shopName,
        role: 'owner',
        isActive: true,
      });

      const nonGstPasswordHash = await bcrypt.hash(nonGstAdminPassword, 10);
      await createUser({
        shopId: shop.id,
        username: normalizedNonGstUsername,
        passwordHash: nonGstPasswordHash,
        passwordEncrypted: encryptPassword(nonGstAdminPassword),
        name: `${ownerName || shopName} (Non-GST)`,
        role: 'operator',
        isActive: true,
      });

      await pgPool.query(
        `INSERT INTO gold_rates (gold24, gold22, gold20, gold18, silver, shop_id)
         VALUES (0, 0, 0, 0, 0, $1)`,
        [shop.id]
      );
    } catch (provisionError: any) {
      await deleteShop(shop.id); // cascades away any partial seed rows
      throw provisionError;
    }

    res.status(201).json({
      shop: rowToApi(shop),
      loginCredentials: [
        { label: 'GST Owner Login', username: normalizedGstUsername, password: gstAdminPassword },
        {
          label: 'Non-GST Operator Login',
          username: normalizedNonGstUsername,
          password: nonGstAdminPassword,
        },
      ],
    });
  } catch (error: any) {
    console.error('[Create shop/pg] error:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to create shop' });
  }
});

// Update shop details / plan / status / extend subscription
router.put('/shops/:id', async (req: Request, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.dbName;
    delete updateData.legacyDbName;
    delete updateData.slug; // slug changes go through the dedicated endpoint
    delete updateData.id;
    delete updateData._id;

    const shop = await updateShop(req.params.id, updateData);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(rowToApi(shop));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to update shop' });
  }
});

// Change how the shop logs in (slug) — data binding is unaffected in the
// single-DB model, so this is purely a slug rename with a uniqueness check.
router.post('/shops/:id/update-slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const normalizedSlug = String(slug).toLowerCase().trim().replace(/\s+/g, '-');
    if (!normalizedSlug) return res.status(400).json({ error: 'Invalid slug' });

    const shop = await findShopById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    if (shop.slug === normalizedSlug) return res.json(rowToApi(shop));

    const clash = await findShopBySlug(normalizedSlug);
    if (clash) {
      return res.status(409).json({ error: `Shop id "${normalizedSlug}" is already taken` });
    }

    const updated = await updateShopSlug(req.params.id, normalizedSlug);
    res.json(rowToApi(updated));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to update slug' });
  }
});

router.post('/shops/:id/suspend', async (req: Request, res: Response) => {
  try {
    const shop = await updateShopStatus(req.params.id, 'suspended');
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(rowToApi(shop));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to suspend shop' });
  }
});

router.post('/shops/:id/activate', async (req: Request, res: Response) => {
  try {
    const shop = await updateShopStatus(req.params.id, 'active');
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(rowToApi(shop));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to activate shop' });
  }
});

router.post('/shops/:id/renew', async (req: Request, res: Response) => {
  try {
    const { newEndDate, plan } = req.body;
    if (!newEndDate) return res.status(400).json({ error: 'newEndDate is required' });

    const updates: Record<string, unknown> = {
      subscriptionEndDate: new Date(newEndDate),
      status: 'active',
    };
    if (plan) updates.plan = plan;

    const shop = await updateShop(req.params.id, updates);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(rowToApi(shop));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to renew subscription' });
  }
});

// Reset a shop user's password (support action)
router.post('/shops/:id/reset-user-password', async (req: Request, res: Response) => {
  try {
    const { username, role, newPassword } = req.body;
    if (!username || !role || !newPassword) {
      return res.status(400).json({ error: 'username, role, and newPassword are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const shop = await findShopById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const normalizedUsername = String(username).toLowerCase().trim();
    const normalizedRole = String(role).toLowerCase().trim();

    const user = await findUserByUsername(shop.id, normalizedUsername);
    if (!user || user.role !== normalizedRole) {
      return res.status(404).json({
        error: `User not found in this shop. username="${normalizedUsername}", role="${normalizedRole}", shop="${shop.slug}"`,
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await updateUserPasswordByUsername(
      shop.id,
      normalizedUsername,
      passwordHash,
      encryptPassword(newPassword)
    );

    res.json({
      message: `Password reset successfully for user "${normalizedUsername}" (${normalizedRole})`,
      newPassword,
      user: { username: updated!.username, role: updated!.role },
    });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to reset password' });
  }
});

// View a shop user's current password (support action). Only works when a
// recoverable `password_encrypted` copy exists.
router.get('/shops/:id/users/:role/password', async (req: Request, res: Response) => {
  try {
    const role = String(req.params.role).toLowerCase().trim();
    if (!['owner', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'role must be "owner" or "operator"' });
    }

    const shop = await findShopById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const canonicalUsername =
      role === 'owner' ? shop.initial_admin_username : shop.initial_operator_username;
    if (!canonicalUsername) {
      return res.status(404).json({ error: `No ${role} username recorded for this shop` });
    }

    const user = await findUserByUsername(shop.id, canonicalUsername);
    if (!user || user.role !== role) {
      return res.status(404).json({ error: `No ${role} user found for this shop` });
    }
    if (!user.password_encrypted) {
      return res.status(404).json({
        error: `No recoverable password stored for "${user.username}" — it was set before this feature existed. Use Reset Password to set a new one.`,
      });
    }

    res.json({
      username: user.username,
      role: user.role,
      password: decryptPassword(user.password_encrypted),
    });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to read password' });
  }
});

/**
 * Delete a shop from the registry.
 *
 * Unlike the Mongo route (which left the tenant database intact for manual
 * recovery), every shop-scoped table here has an `ON DELETE CASCADE` FK to
 * `shops`, so this removes the shop AND all of its business rows.
 */
router.delete('/shops/:id', async (req: Request, res: Response) => {
  try {
    const shop = await deleteShop(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json({
      message:
        'Shop deleted from registry. All of its data was removed via ON DELETE CASCADE.',
      slug: shop.slug,
    });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to delete shop' });
  }
});

export default router;
