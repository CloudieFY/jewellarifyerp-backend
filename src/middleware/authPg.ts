import { Request, Response, NextFunction } from 'express';
import {
  verifyTenantToken,
  verifySuperAdminToken,
  TenantTokenPayload,
  SuperAdminTokenPayload,
} from '../utils/jwt';
import { findShopById, ShopRow } from '../repositories/shopRepository';
import { rowToApi } from '../db/mapping';
import { pgPool } from '../config/postgres';
import { resolveUserPermissions, expandPermissions } from '../crm/permissions';

/**
 * PostgreSQL tenant-auth middleware — the security boundary for every
 * tenant-scoped route on the PG stack.
 *
 * Mirrors `middleware/auth.ts` (the Mongo version) but there is no
 * per-shop database: the verified JWT carries `shopId`, we confirm the shop
 * still exists and is in good standing, and attach `req.pgTenant.shopId`.
 * Route handlers scope every query with `WHERE shop_id = $1` using that value,
 * which comes only from the signed token — never from the request.
 *
 * It also loads the caller's `users` row (CRM columns included) so
 * `req.pgTenant.permissionSet` reflects the CURRENT database state on every
 * request — a revoked CRM permission or role takes effect immediately, with
 * no token re-issue. CRM routes read this via `requireCrmPermission()`.
 */

/** The tenant context every PG route sees on `req.pgTenant`. */
export interface PgTenantContext {
  shopId: string;
  shop: any;
  shopRow: ShopRow;
  /** ERP role from the verified JWT: 'owner' | 'operator' | 'karigar'. */
  role: TenantTokenPayload['role'];
  /** Optional CRM persona from `users.crm_role` (null for most ERP logins). */
  crmRole: string | null;
  /** Effective CRM permissions, wildcards expanded (for API/UX responses). */
  permissions: string[];
  /** Effective CRM permissions as a Set (may contain `*` / `<entity>.*`). */
  permissionSet: Set<string>;
  user: {
    id: string;
    username: string;
    name: string | null;
    role: TenantTokenPayload['role'];
    /** Raw additive grants from `users.permissions` (un-expanded). */
    permissions: string[];
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      pgTenant?: PgTenantContext;
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

interface CrmUserRow {
  id: string;
  username: string;
  name: string | null;
  role: TenantTokenPayload['role'];
  crm_role: string | null;
  permissions: string[] | null;
  is_active: boolean;
}

/** Load the live `users` row for the token subject, scoped to the shop. */
async function loadTenantUser(userId: string, shopId: string): Promise<CrmUserRow | null> {
  const { rows } = await pgPool.query(
    `SELECT id, username, name, role, crm_role, permissions, is_active
       FROM users
      WHERE id = $1 AND shop_id = $2`,
    [userId, shopId],
  );
  return (rows[0] as CrmUserRow) ?? null;
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

      // Live user row — the source of truth for CRM role / permissions.
      const userRow = await loadTenantUser(payload.sub, payload.shopId);
      if (!userRow || userRow.is_active === false) {
        return res.status(401).json({ error: 'User not found or inactive' });
      }

      const rawGrants = Array.isArray(userRow.permissions) ? userRow.permissions : [];
      const permissionSet = resolveUserPermissions({
        role: userRow.role,
        crm_role: userRow.crm_role,
        permissions: rawGrants,
      });

      req.tenantAuth = payload;
      req.pgTenant = {
        shopId: payload.shopId,
        shop: rowToApi(shop),
        shopRow: shop,
        role: userRow.role,
        crmRole: userRow.crm_role ?? null,
        permissions: expandPermissions(permissionSet),
        permissionSet,
        user: {
          id: userRow.id,
          username: userRow.username,
          name: userRow.name ?? null,
          role: userRow.role,
          permissions: rawGrants,
        },
      };
      next();
    } catch (err: any) {
      console.error('[requirePgTenantAuth] error:', err?.message || err);
      res.status(500).json({ error: 'Failed to establish tenant context' });
    }
  };
}
