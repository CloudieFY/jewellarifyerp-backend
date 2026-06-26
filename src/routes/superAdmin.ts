import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getMasterConnection } from '../config/masterDb';
import { getSuperAdminModel } from '../models/master/SuperAdmin';
import { getShopModel } from '../models/master/Shop';
import { signSuperAdminToken } from '../utils/jwt';
import { requireSuperAdmin } from '../middleware/auth';
import { getDemoRequestModel } from '@/models/master/DemoRequest';
import { getTenantContext, closeTenantConnection, dbNameForShop } from '../config/tenantDb';

const router = Router();

/* ---------------------------------------------------------------------- */
/*  AUTH                                                                   */
/* ---------------------------------------------------------------------- */

// Super admin login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const normalizedUsername = String(username).toLowerCase().trim();

    // Debug logs to quickly pinpoint why credentials are rejected.
    // (Do NOT log passwords or password hashes.)
    console.log('[SuperAdmin login] attempt:', { normalizedUsername });

    const masterConn = getMasterConnection();
    console.log('[SuperAdmin login] master connected');
    const SuperAdmin = getSuperAdminModel(masterConn);
    const admin = await SuperAdmin.findOne({ username: normalizedUsername });


    if (!admin) {
      console.log('[SuperAdmin login] no superadmin found for username:', { normalizedUsername });
      return res.status(401).json({ error: 'User not found' });
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      console.log('[SuperAdmin login] password mismatch for username:', { normalizedUsername });
      return res.status(401).json({ error: 'User not found' });
    }


    const token = signSuperAdminToken({ sub: admin.id, username: admin.username });



    // Normalize admin shape for frontend expectations
    // (frontend expects: { id, username, name })
    const normalizedAdmin = {
      id: admin.id,
      username: admin.username,
      name: (admin as any).name || admin.username,
    };

    res.json({ token, admin: normalizedAdmin });
  } catch (error: any) {
    console.error('[SuperAdmin login] error:', error?.message || error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// Create a new demo request (public)
router.post('/demo-requests', async (req: Request, res: Response) => {
  try {
    const { name, shopName, phone, email, address } = req.body;
    if (!name || !shopName || !phone) {
      return res.status(400).json({ error: 'Name, shop name, and phone are required' });
    }

    const masterConn = getMasterConnection();
    const DemoRequest = getDemoRequestModel(masterConn);

    const newRequest = new DemoRequest({ name, shopName, phone, email, address, status: 'Pending' });
    await newRequest.save();

    res.status(201).json(newRequest.toJSON());
  } catch (error: any) {
    console.error('[Demo Request] create error:', error.message);
    res.status(500).json({ error: 'Failed to submit demo request.' });
  }
});


// Get current super admin profile
router.get('/me', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const SuperAdmin = getSuperAdminModel(masterConn);
    const admin = await SuperAdmin.findById(req.superAdmin!.sub);
    if (!admin) return res.status(404).json({ error: 'Not found' });
    res.json(admin.toJSON());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/* ---------------------------------------------------------------------- */
/*  SHOP (TENANT) MANAGEMENT — all routes below require super admin auth  */
/* ---------------------------------------------------------------------- */

router.use(requireSuperAdmin);

// Get all demo requests (protected)
router.get('/demo-requests', async (_req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const DemoRequest = getDemoRequestModel(masterConn);
    const requests = await DemoRequest.find().sort({ createdAt: -1 });
    res.json(requests.map(r => r.toJSON()));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update a demo request status (protected)
router.put('/demo-requests/:id', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    const masterConn = getMasterConnection();
    const DemoRequest = getDemoRequestModel(masterConn);
    const updatedRequest = await DemoRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!updatedRequest) return res.status(404).json({ error: 'Request not found' });
    res.json(updatedRequest.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// List all shops
router.get('/shops', async (_req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shops = await Shop.find().sort({ createdAt: -1 }).lean();

    // Augment shop data with user counts from each tenant DB
    const shopsWithDetails = await Promise.all(
      shops.map(async (shop) => {
        try {
          const tenantModels = await getTenantContext(shop.dbName);
          const userCount = await tenantModels.User.countDocuments();
          // Manually apply the toJSON transform that .lean() skips
          const shopWithId = { ...shop, id: shop._id.toString() };
          return { ...shopWithId, userCount };
        } catch (e) {
          // Also apply the transform on error cases
          const shopWithId = { ...shop, id: shop._id.toString() };
          return { ...shopWithId, userCount: 0, error: 'DB_CONN_FAILED' };
        }
      })
    );

    res.json(shopsWithDetails);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get one shop
router.get('/shops/:id', async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a new shop.
 *
 * This is the key SaaS onboarding step:
 *  1. Create the Shop record in the master DB (slug, plan, dates...).
 *  2. Immediately provision that shop's OWN physical database by opening a
 *     connection to it (Mongo creates databases lazily on first write, so
 *     we force a write by creating the initial owner User document there).
 *  3. Return the shop's login id + the temporary password so the super
 *     admin can hand it to the shop owner.
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
      return res.status(400).json({
        error: 'slug, shopName, and both sets of admin credentials are required',
      });
    }
    if (String(gstAdminPassword).length < 6 || String(nonGstAdminPassword).length < 6) {
      return res.status(400).json({ error: 'All admin passwords must be at least 6 characters' });
    }

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);

    const normalizedSlug = String(slug).toLowerCase().trim().replace(/\s+/g, '-');
    const existing = await Shop.findOne({ slug: normalizedSlug });
    if (existing) {
      return res.status(409).json({ error: `Shop id "${normalizedSlug}" is already taken` });
    }

    const endDate = subscriptionEndDate
      ? new Date(subscriptionEndDate)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // default 30-day trial

    const shop = new Shop({
      slug: normalizedSlug,
      shopName,
      ownerName,
      email,
      phone,
      logoUrl,
      address,
      gstNumber,
      plan: plan || 'trial',
      status: 'active',
      subscriptionStartDate: new Date(),
      subscriptionEndDate: endDate,
      initialAdminUsername: gstAdminUsername.toLowerCase().trim(),
      dbName: '', // filled below once we know the _id
      notes,
    });

    shop.dbName = dbNameForShop(normalizedSlug);
    await shop.save();

    // Step 2: provision the shop's own physical database + first owner user.
    const tenantModels = await getTenantContext(shop.dbName);

    // Create GST Owner (role: 'owner')
    const gstPasswordHash = await bcrypt.hash(gstAdminPassword, 10);
    await tenantModels.User.create({
      username: gstAdminUsername.toLowerCase().trim(),
      passwordHash: gstPasswordHash,
      name: ownerName || shopName,
      role: 'owner',
      isActive: true,
    });

    // Create Non-GST Operator (role: 'operator')
    const nonGstPasswordHash = await bcrypt.hash(nonGstAdminPassword, 10);
    await tenantModels.User.create({
      username: nonGstAdminUsername.toLowerCase().trim(),
      passwordHash: nonGstPasswordHash,
      name: `${ownerName || shopName} (Non-GST)`,
      role: 'operator',
      isActive: true,
    });

    // Seed a default gold rates document so the shop's app has something to show.
    await tenantModels.GoldRates.create({ gold24: 0, gold22: 0, gold18: 0, silver: 0 });

    res.status(201).json({
      shop: shop.toJSON(),
      loginCredentials: [
        {
          label: 'GST Owner Login',
          username: gstAdminUsername.toLowerCase().trim(),
          password: gstAdminPassword,
        },
        {
          label: 'Non-GST Operator Login',
          username: nonGstAdminUsername.toLowerCase().trim(),
          password: nonGstAdminPassword,
        },
      ],
    });
  } catch (error: any) {
    console.error('[Create shop] error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Update shop details / plan / status / extend subscription
router.put('/shops/:id', async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);

    const updateData = { ...req.body };
    delete updateData.dbName; // never allow changing the physical db binding
    delete updateData.slug; // slug changes are handled via a dedicated endpoint

    if (updateData.subscriptionEndDate) {
      updateData.subscriptionEndDate = new Date(updateData.subscriptionEndDate);
    }

    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { $set: updateData }, // Use $set to perform a partial update
      {
        new: true,
        runValidators: true,
      }
    );
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Update shop slug (shop id) without migrating tenant DB.
// Only changes how the shop logs in (slug in master DB). Tenant DB stays the same.
router.post('/shops/:id/update-slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const normalizedSlug = String(slug).toLowerCase().trim().replace(/\s+/g, '-');
    if (!normalizedSlug) return res.status(400).json({ error: 'Invalid slug' });

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);

    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    if (shop.slug === normalizedSlug) {
      return res.json(shop.toJSON());
    }

    const existing = await Shop.findOne({ slug: normalizedSlug });
    if (existing) {
      return res.status(409).json({ error: `Shop id "${normalizedSlug}" is already taken` });
    }

    shop.slug = normalizedSlug;
    await shop.save();

    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});


// Suspend a shop (blocks login immediately, data stays intact)
router.post('/shops/:id/suspend', async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { status: 'suspended' },
      { new: true }
    );
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    await closeTenantConnection(shop.dbName);
    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Reactivate a suspended shop
router.post('/shops/:id/activate', async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { status: 'active' },
      { new: true }
    );
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Extend / renew subscription
router.post('/shops/:id/renew', async (req: Request, res: Response) => {
  try {
    const { newEndDate, plan } = req.body;
    if (!newEndDate) return res.status(400).json({ error: 'newEndDate is required' });

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const update: any = {
      subscriptionEndDate: new Date(newEndDate),
      status: 'active',
    };
    if (plan) update.plan = plan;

    const shop = await Shop.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Reset a shop's user password (super admin support action)
router.post('/shops/:id/reset-user-password', async (req: Request, res: Response) => {
  try {
    const { username, role, newPassword } = req.body;
    if (!username || !role || !newPassword) {
      return res.status(400).json({ error: 'username, role, and newPassword are required' });
    }
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const tenantModels = await getTenantContext(shop.dbName);
    const normalizedUsername = String(username).toLowerCase().trim();
    const normalizedRole = String(role).toLowerCase().trim();

    const user = await tenantModels.User.findOne({ username: normalizedUsername, role: normalizedRole });
    if (!user) {
      return res.status(404).json({
        error: `User not found in this shop. username="${normalizedUsername}", role="${normalizedRole}", shopDb="${shop.dbName}"`,
      });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({
      message: `Password reset successfully for user "${user.username}" (${user.role})`,
      newPassword, // Return the new password
      user: user.toJSON?.() ?? { username: user.username, role: user.role },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Permanently delete a shop record (does NOT drop the physical database —
// safety measure so data can be recovered manually if needed; see notes)
router.delete('/shops/:id', async (req: Request, res: Response) => {
  try {
    const masterConn = getMasterConnection();
    const Shop = getShopModel(masterConn);
    const shop = await Shop.findByIdAndDelete(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    await closeTenantConnection(shop.dbName);
    res.json({
      message: 'Shop deleted from registry. The underlying database was NOT dropped automatically — remove it manually in Atlas if you want to permanently erase its data.',
      dbName: shop.dbName,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
