import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { requirePgTenantAuth } from '../../middleware/authPg';
import { hasAnyCrmAccess } from '../permissions';

/**
 * CRM meta endpoints.
 *
 *   GET /api/crm/health  — unauthenticated liveness + phase marker
 *   GET /api/crm/me      — the caller's effective CRM access (role, permissions,
 *                          allowed branch ids). Drives frontend UX gating; the
 *                          backend still enforces every permission itself.
 */

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  res.json({ status: 'OK', module: 'crm', phase: 2 });
});

router.get('/me', requirePgTenantAuth(), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  let branchIds: string[] = [];
  try {
    branchIds = await withTenant(ctx.shopId, async (client) => {
      const { rows } = await client.query(
        `SELECT branch_id FROM user_branches WHERE shop_id = $1 AND user_id = $2`,
        [ctx.shopId, ctx.user.id],
      );
      return rows.map((r) => r.branch_id as string);
    });
  } catch (err: any) {
    console.error('[GET /api/crm/me] branch lookup failed:', err?.message || err);
  }

  res.json({
    user: {
      id: ctx.user.id,
      username: ctx.user.username,
      name: ctx.user.name,
      role: ctx.role,
    },
    crmRole: ctx.crmRole,
    permissions: ctx.permissions,
    hasCrmAccess: hasAnyCrmAccess({
      role: ctx.role,
      crm_role: ctx.crmRole,
      permissions: ctx.user.permissions ?? [],
    }),
    branchIds,
    /** empty array => user may act shop-wide (all branches) */
    branchScope: branchIds.length > 0 ? 'restricted' : 'shop_wide',
  });
});

export default router;
