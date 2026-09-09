/**
 * CRM permission enforcement middleware.
 *
 * Usage in a CRM route:
 *
 *   router.get('/', ...requireCrmPermission('lead', 'view'), handler);
 *   router.post('/:id/win', ...requireCrmPermission('opportunity', 'win'), handler);
 *
 * It returns an ARRAY: [ requirePgTenantAuth(), <permission gate> ]. Mounting
 * `requirePgTenantAuth()` here guarantees `req.pgTenant.permissionSet` is
 * populated from the *current* DB state (see middleware/authPg.ts), so a
 * revoked permission takes effect on the very next request.
 *
 * This is the ONLY place CRM authorization is enforced. Frontend checks are
 * UX-only and are never trusted.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { requirePgTenantAuth } from '../../middleware/authPg';
import { can, isValidCrmPermission } from '../permissions';

export function requireCrmPermission(entity: string, action: string): RequestHandler[] {
  const permission = `${entity}.${action}`;
  if (!isValidCrmPermission(permission)) {
    // Fail fast at wiring time — a typo'd permission must never silently
    // become "allow".
    throw new Error(`requireCrmPermission: unknown CRM permission "${permission}"`);
  }

  const gate: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.pgTenant;
    if (!ctx) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!can(ctx.permissionSet, entity, action)) {
      return res.status(403).json({
        error: `Missing CRM permission: ${permission}`,
      });
    }
    next();
  };

  return [requirePgTenantAuth(), gate];
}

/**
 * Bare gate (no auth middleware prepended) for routes that already ran
 * `requirePgTenantAuth()` earlier in their chain.
 */
export function crmPermissionGate(entity: string, action: string): RequestHandler {
  const permission = `${entity}.${action}`;
  if (!isValidCrmPermission(permission)) {
    throw new Error(`crmPermissionGate: unknown CRM permission "${permission}"`);
  }
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.pgTenant;
    if (!ctx) return res.status(401).json({ error: 'Authentication required' });
    if (!can(ctx.permissionSet, entity, action)) {
      return res.status(403).json({ error: `Missing CRM permission: ${permission}` });
    }
    next();
  };
}
