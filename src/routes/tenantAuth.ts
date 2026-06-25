import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';
import { getTenantContext } from '../config/tenantDb';
import { signTenantToken } from '../utils/jwt';
import { requireTenantAuth } from '../middleware/auth';

const router = Router();

/**
 * Shop user login.
 *
 * The shop owner gives their staff a "Shop ID" (the slug, e.g.
 * "arihant-jewellers") plus a username/password. We look up the shop by
 * slug in the master DB first (to find which physical database to talk
 * to), confirm the shop is active/not expired, THEN open that shop's own
 * connection and check the username/password against ITS User collection.
 *
 * No tenant data is touched until the shop itself is verified to exist
 * and be in good standing.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { shopSlug, username, password } = req.body;
    if (!shopSlug || !username || !password) {
      return res.status(400).json({ error: 'shopSlug, username and password are required' });
    }

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findOne({ slug: String(shopSlug).toLowerCase().trim() });
    if (!shop) return res.status(401).json({ error: 'User not found' });
    
    if (shop.status === 'suspended') {
      return res.status(403).json({ error: 'This shop account has been suspended. Contact support.' });
    }
    if (shop.status === 'expired' || shop.subscriptionEndDate < new Date()) {
      return res.status(403).json({ error: 'This shop subscription has expired. Please renew to continue.' });
    }

    const tenantModels = await getTenantContext(shop.dbName);
    const user = await tenantModels.User.findOne({ username: String(username).toLowerCase().trim() });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'User not found' });

    const token = signTenantToken({
      sub: user.id,
      shopId: shop._id.toString(),
      username: user.username,
      role: user.role,
      karigarRefId: user.karigarRefId,
    });

    res.json({
      token,
      user: user.toJSON(),
      shop: shop.toJSON(), // Send the full shop object
    });
  } catch (error: any) {
    console.error('[Tenant login] error:', error.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current logged-in tenant user + shop info
router.get('/me', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const user = await req.tenant!.models.User.findById(req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findById(req.tenant!.shopId);

    res.json({
      user: user.toJSON(),
      shop: shop?.toJSON() ?? null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update own shop details (owner only)
router.put('/shop', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);

    const updateData = { ...req.body };
    // Prevent critical fields from being changed by the tenant
    delete updateData.id;
    delete updateData._id;
    delete updateData.slug;
    delete updateData.dbName;
    delete updateData.status;
    delete updateData.plan;
    delete updateData.subscriptionStartDate;
    delete updateData.subscriptionEndDate;

    const user = await req.tenant!.models.User.findById(req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found while updating shop' });

    const shop = await Shop.findByIdAndUpdate(
      req.tenant!.shopId,
      { $set: updateData }, // Use $set to perform a partial update
      { new: true, runValidators: true }
    );
    res.json({
      user: user.toJSON(),
      shop: shop?.toJSON() ?? null,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});
// Change own password
router.post('/change-password', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const user = await req.tenant!.models.User.findById(req.tenantAuth!.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Shop-staff management — only the shop owner can create/manage additional
 * logins for their own shop (e.g. a GST operator account, or a karigar
 * portal login). Everything here is automatically scoped to req.tenant,
 * so an owner can only ever manage users inside their OWN shop database.
 */
router.get('/users', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const users = await req.tenant!.models.User.find().sort({ createdAt: -1 });
    res.json(users.map((u) => u.toJSON()));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/users', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const { username, password, name, role, karigarRefId } = req.body;
    if (!username || !password || !name || !role) {
      return res.status(400).json({ error: 'username, password, name and role are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await req.tenant!.models.User.create({
      username: String(username).toLowerCase().trim(),
      passwordHash,
      name,
      role,
      karigarRefId,
      isActive: true,
    });
    res.status(201).json(user.toJSON());
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A user with this username already exists in your shop' });
    }
    res.status(400).json({ error: error.message });
  }
});

router.put('/users/:id', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const updateData: any = { ...req.body };
    delete updateData.passwordHash;
    if (updateData.password) {
      updateData.passwordHash = await bcrypt.hash(updateData.password, 10);
      delete updateData.password;
    }
    const user = await req.tenant!.models.User.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/users/:id', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    if (req.params.id === req.tenantAuth!.sub) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const user = await req.tenant!.models.User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
