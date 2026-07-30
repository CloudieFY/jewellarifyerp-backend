import { Request, Response, NextFunction } from 'express';
import { verifySuperAdminToken, verifyTenantToken, SuperAdminTokenPayload, TenantTokenPayload } from '../utils/jwt';
import { getTenantContext } from '../config/tenantDb';
import { TenantModels } from '../models/tenant/registerTenantModels';
import { getMasterConnection } from '../config/masterDb';
import { getShopModel } from '../models/master/Shop';

// Extend Express Request with the auth context we attach.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      superAdmin?: SuperAdminTokenPayload;
      tenantAuth?: TenantTokenPayload;
      tenant?: {
        shopId: string;
        shop: any;
        models: TenantModels;
      };
    }
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  return null;
}

/**
 * Protects super-admin-only routes (e.g. POST /api/superadmin/shops).
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Authorization token' });

  try {
    const payload = verifySuperAdminToken(token);
    if (payload.type !== 'superadmin') {
      return res.status(403).json({ error: 'Not a super admin token' });
    }
    req.superAdmin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Protects every tenant-scoped route (customers, inventory, sales, etc.)
 *
 * This is the critical security boundary: it verifies the JWT, reads the
 * shopId embedded in it, confirms that shop is still active/not expired,
 * and then attaches a Models bundle bound ONLY to that shop's physical
 * database. Route handlers below this middleware never see or choose a
 * shopId themselves - it always comes from the verified token, never from
 * a request body/param/query, so a user can never spoof a different shop's
 * id to read another tenant's data.
 */
export function requireTenantAuth(allowedRoles?: Array<'owner' | 'operator' | 'karigar'>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Missing Authorization token' });

    let payload: TenantTokenPayload;
    try {
      payload = verifyTenantToken(token);
      if (payload.type !== 'tenant') {
        return res.status(403).json({ error: 'Not a tenant token' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (allowedRoles && !allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: 'You do not have permission to access this resource' });
    }

    try {
      // Re-validate the shop is still active/not expired on every request.
      const masterConn = getMasterConnection();
      const Shop = getShopModel(masterConn);
      const shop = await Shop.findById(payload.shopId);

      if (!shop) return res.status(404).json({ error: 'Shop not found' });
      if (shop.status === 'suspended') {
        return res.status(403).json({ error: 'This shop account has been suspended. Contact support.' });
      }
      if (shop.status === 'expired' || shop.subscriptionEndDate < new Date()) {
        return res.status(403).json({ error: 'This shop subscription has expired. Please renew to continue.' });
      }

      // It's crucial to use the dbName from the verified shop document,
      // not from any part of the JWT payload, to ensure we always
      // connect to the correct database.
      const models = await getTenantContext(shop.dbName);

      // Attach auth payload and tenant context to the request for use in route handlers
      req.tenantAuth = payload;
      req.tenant = { shopId: payload.shopId, shop: shop.toJSON(), models };
      next();
    } catch (err: any) {
      console.error('[requireTenantAuth] error:', err.message);
      res.status(500).json({ error: 'Failed to establish tenant database context' });
    }
  };
}
