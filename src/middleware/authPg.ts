import { Request, Response, NextFunction } from 'express';
import {
  verifyTenantToken,
  verifySuperAdminToken,
  TenantTokenPayload,
  SuperAdminTokenPayload,
} from '../utils/jwt';
import { findShopById, ShopRow } from '../repositories/shopRepository';
import { rowToApi } from '../db/mapping';

/**
 * PostgreSQL tenant-auth middleware — the security boundary for every
 * tenant-scoped route on the PG stack.
 *
 * Mirrors `middleware/auth.ts` (the Mongo version) but there is no
 * per-shop database: the verified JWT carries `shopId`, we confirm the shop
 * still exists and is in good standing, and attach `req.pgTenant.shopId`.
 * Route handlers scope every query with `WHERE shop_id = $1` using that value,
 * which comes only from the signed token — never from the request.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      pgTenant?: {
        shopId: string;
        shop: any;
        shopRow: ShopRow;
      };
      superAdmin?: SuperAdminTokenPayload;
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
 * Protects super-admin-only routes on the PG stack (the platform control
 * plane: shop provisioning, demo requests, subscription management).
 *
 * Pure JWT verification — same token shape and secret as the Mongo
 * `middleware/auth.ts::requireSuperAdmin`, minus the mongoose imports that
 * file drags in.
 */
export function requireSuperAdminPg(req: Request, res: Response, next: NextFunction) {
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

export function requirePgTenantAuth(
  allowedRoles?: Array<'owner' | 'operator' | 'karigar'>
) {
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
      const shop = await findShopById(payload.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found' });

      if (shop.status === 'suspended') {
        return res.status(403).json({ error: 'This shop account has been suspended. Contact support.' });
      }
      if (shop.status === 'expired' || new Date(shop.subscription_end_date) < new Date()) {
        return res.status(403).json({ error: 'This shop subscription has expired. Please renew to continue.' });
      }

      req.tenantAuth = payload;
      req.pgTenant = {
        shopId: payload.shopId,
        shop: rowToApi(shop),
        shopRow: shop,
      };
      next();
    } catch (err: any) {
      console.error('[requirePgTenantAuth] error:', err?.message || err);
      res.status(500).json({ error: 'Failed to establish tenant context' });
    }
  };
}
