import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signTenantToken } from '../utils/jwt';
import { encryptPassword } from '../utils/passwordCrypto';
import { requirePgTenantAuth } from '../middleware/authPg';
import { rowToApi } from '../db/mapping';
import {
  findShopBySlug,
  findShopById,
  listShops,
  updateShop,
} from '../repositories/shopRepository';
import {
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  UserRow,
} from '../repositories/userRepository';

/**
 * PostgreSQL port of `routes/tenantAuth.ts`.
 *
 * There is no per-shop database any more: the shop registry and every shop's
 * users live in the single Postgres DB, scoped by `shop_id`. Login resolves
 * the shop (by slug, or by scanning active shops for a matching username),
 * verifies the bcrypt hash, and issues the same tenant JWT shape as before.
 */

const router = Router();

/** Strip secret columns before returning a user to the client. */
function publicUser(row: UserRow): any {
  const obj = rowToApi<any>(row)!;
  delete obj.passwordHash;
  delete obj.passwordEncrypted;
  return obj;
}

function shopIsUsable(shop: { status: string; subscription_end_date: Date | string }): {
  ok: boolean;
  status?: number;
  error?: string;
} {
  if (shop.status === 'suspended') {
    return { ok: false, status: 403, error: 'This shop account has been suspended. Contact support.' };
  }
  if (shop.status === 'expired' || new Date(shop.subscription_end_date) < new Date()) {
    return { ok: false, status: 403, error: 'This shop subscription has expired. Please renew to continue.' };
  }
  return { ok: true };
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { shopSlug, username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const cleanUsername = String(username).toLowerCase().trim();

    let targetShop: any = null;
    let targetUser: UserRow | null = null;

    if (shopSlug && String(shopSlug).trim()) {
      const shop = await findShopBySlug(String(shopSlug).toLowerCase().trim());
      if (!shop) return res.status(401).json({ error: 'User not found' });

      const usable = shopIsUsable(shop);
      if (!usable.ok) return res.status(usable.status!).json({ error: usable.error });

      const user = await findUserByUsername(shop.id, cleanUsername);
      if (user && user.is_active && (await bcrypt.compare(password, user.password_hash))) {
        targetShop = shop;
        targetUser = user;
      }
    } else {
      const shops = await listShops();
      for (const shop of shops) {
        if (shop.status === 'suspended') continue;
        if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) continue;
        try {
          const user = await findUserByUsername(shop.id, cleanUsername);
          if (user && user.is_active && (await bcrypt.compare(password, user.password_hash))) {
            targetShop = shop;
            targetUser = user;
            break;
          }
        } catch {
          // ignore an individual shop lookup failure
        }
      }
    }

    if (!targetShop || !targetUser) {
      return res.status(401).json({ error: 'User not found' });
    }

    const token = signTenantToken({
      sub: targetUser.id,
      shopId: targetShop.id,
      username: targetUser.username,
      role: targetUser.role,
      karigarRefId: targetUser.karigar_ref_id ?? undefined,
    });

    res.json({
      token,
      user: publicUser(targetUser),
      shop: rowToApi(targetShop),
    });
  } catch (error: any) {
    console.error('[Tenant login PG] error:', error?.message || error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const user = await findUserById(req.pgTenant!.shopId, req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const shop = await findShopById(req.pgTenant!.shopId);
    res.json({ user: publicUser(user), shop: shop ? rowToApi(shop) : null });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load profile' });
  }
});

router.put('/shop', requirePgTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const updateData: Record<string, unknown> = { ...req.body };
    // Fields a tenant may never change about their own shop.
    for (const k of [
      'id', '_id', 'slug', 'dbName', 'legacyDbName', 'status', 'plan',
      'subscriptionStartDate', 'subscriptionEndDate', 'createdAt', 'updatedAt',
    ]) {
      delete updateData[k];
    }

    const user = await findUserById(req.pgTenant!.shopId, req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found while updating shop' });

    const shop = await updateShop(req.pgTenant!.shopId, updateData);
    res.json({ user: publicUser(user), shop: shop ? rowToApi(shop) : null });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to update shop' });
  }
});

router.post('/change-password', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const user = await findUserById(req.pgTenant!.shopId, req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    await updateUser(req.pgTenant!.shopId, user.id, {
      passwordHash: await bcrypt.hash(newPassword, 10),
      passwordEncrypted: encryptPassword(newPassword),
    });
    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to change password' });
  }
});

router.put('/language', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { preferredLanguage } = req.body;
    const ALLOWED = ['en', 'hi', 'gu', 'mr', 'ta', 'te', 'kn', 'ml', 'pa', 'bn', 'or'];
    if (!ALLOWED.includes(preferredLanguage)) {
      return res.status(400).json({ error: `preferredLanguage must be one of: ${ALLOWED.join(', ')}` });
    }
    const updated = await updateUser(req.pgTenant!.shopId, req.tenantAuth!.sub, { preferredLanguage });
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(publicUser(updated));
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to set language' });
  }
});

router.get('/users', requirePgTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const users = await listUsers(req.pgTenant!.shopId);
    res.json(users.map(publicUser));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to list users' });
  }
});

router.post('/users', requirePgTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const { username, password, name, role, karigarRefId } = req.body;
    if (!username || !password || !name || !role) {
      return res.status(400).json({ error: 'username, password, name and role are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    const user = await createUser({
      shopId: req.pgTenant!.shopId,
      username: String(username).toLowerCase().trim(),
      passwordHash: await bcrypt.hash(password, 10),
      passwordEncrypted: encryptPassword(password),
      name,
      role,
      karigarRefId: karigarRefId || undefined,
      isActive: true,
    });
    res.status(201).json(publicUser(user));
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A user with this username already exists in your shop' });
    }
    res.status(400).json({ error: error?.message || 'Failed to create user' });
  }
});

router.put('/users/:id', requirePgTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const updates: Record<string, unknown> = { ...req.body };
    delete updates.passwordHash;
    delete updates.passwordEncrypted;
    if (updates.password) {
      updates.passwordHash = await bcrypt.hash(String(updates.password), 10);
      updates.passwordEncrypted = encryptPassword(String(updates.password));
      delete updates.password;
    }
    const user = await updateUser(req.pgTenant!.shopId, req.params.id, updates);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(publicUser(user));
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A user with this username already exists in your shop' });
    }
    res.status(400).json({ error: error?.message || 'Failed to update user' });
  }
});

router.delete('/users/:id', requirePgTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    if (req.params.id === req.tenantAuth!.sub) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const user = await deleteUser(req.pgTenant!.shopId, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete user' });
  }
});

export default router;
