import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowsToApi } from '../../db/mapping';
import { requirePgTenantAuth } from '../../middleware/authPg';
import { hasAnyCrmAccess } from '../permissions';
import { requireCrmPermission } from '../middleware/requireCrmPermission';

/**
 * CRM meta endpoints.
 *
 *   GET /api/crm/health   — unauthenticated liveness + phase marker
 *   GET /api/crm/me       — the caller's effective CRM access (role, permissions,
 *                           allowed branch ids). Drives frontend UX gating; the
 *                           backend still enforces every permission itself.
 *   GET /api/crm/users     — active shop users, for assignee pickers
 *   GET /api/crm/branches  — active shop branches, for branch pickers
 *   GET /api/crm/dashboard — shop-wide lead / opportunity / task rollups +
 *                            recent activity, for the CRM dashboard. Read-only
 *                            COUNT/SUM aggregation; gated by `report.view`.
 */

const router = Router();

/** Any user with at least one CRM permission may read the picker lists. */
function requireAnyCrmAccess(req: Request, res: Response): boolean {
  const ctx = req.pgTenant!;
  if (
    !hasAnyCrmAccess({
      role: ctx.role,
      crm_role: ctx.crmRole,
      permissions: ctx.permissions,
    })
  ) {
    res.status(403).json({ error: 'No CRM access' });
    return false;
  }
  return true;
}

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

/* ------------------------------------------------------------------ */
/* GET /api/crm/users — active shop users (assignee picker)            */
/* ------------------------------------------------------------------ */
router.get('/users', requirePgTenantAuth(), async (req: Request, res: Response) => {
  if (!requireAnyCrmAccess(req, res)) return;
  const ctx = req.pgTenant!;
  try {
    const rows = await withTenant(ctx.shopId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, username, role, crm_role
           FROM users
          WHERE shop_id = $1 AND is_active = true
          ORDER BY name ASC`,
        [ctx.shopId],
      );
      return rows;
    });
    res.json(rowsToApi(rows));
  } catch (err: any) {
    console.error('[GET /api/crm/users] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/branches — active shop branches (branch picker)        */
/* ------------------------------------------------------------------ */
router.get('/branches', ...requireCrmPermission('branch', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const rows = await withTenant(ctx.shopId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, code
           FROM branches
          WHERE shop_id = $1 AND deleted_at IS NULL AND status = 'active'
          ORDER BY name ASC`,
        [ctx.shopId],
      );
      return rows;
    });
    res.json(rowsToApi(rows));
  } catch (err: any) {
    console.error('[GET /api/crm/branches] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/dashboard — headline CRM rollups + recent activity     */
/* ------------------------------------------------------------------ */
router.get('/dashboard', ...requireCrmPermission('report', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const data = await withTenant(ctx.shopId, async (client) => {
      const [leadRes, oppRes, taskRes, actRes] = await Promise.all([
        client.query(
          `SELECT
             count(*) FILTER (WHERE deleted_at IS NULL)                                              ::int AS total,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'new')                           ::int AS new,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'contacted')                     ::int AS contacted,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'qualified')                     ::int AS qualified,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'unqualified')                   ::int AS unqualified,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'converted')                     ::int AS converted,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'lost')                          ::int AS lost,
             count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days') ::int AS last30
           FROM crm_lead WHERE shop_id = $1`,
          [ctx.shopId],
        ),
        client.query(
          `SELECT
             count(*) FILTER (WHERE deleted_at IS NULL AND stage NOT IN ('won','lost'))              ::int AS open,
             count(*) FILTER (WHERE deleted_at IS NULL AND stage = 'won')                            ::int AS won,
             count(*) FILTER (WHERE deleted_at IS NULL AND stage = 'lost')                           ::int AS lost,
             coalesce(sum(amount) FILTER (WHERE deleted_at IS NULL AND stage NOT IN ('won','lost')), 0) AS open_value,
             coalesce(sum(amount) FILTER (WHERE deleted_at IS NULL AND stage = 'won'), 0)               AS won_value,
             coalesce(sum(amount) FILTER (WHERE deleted_at IS NULL AND stage = 'won'
                      AND won_at >= now() - interval '30 days'), 0)                                     AS won_value30
           FROM crm_opportunity WHERE shop_id = $1`,
          [ctx.shopId],
        ),
        client.query(
          `SELECT
             count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('open','in_progress'))         ::int AS pending,
             count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('open','in_progress')
                      AND due_at IS NOT NULL AND due_at < now())                                      ::int AS overdue,
             count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('open','in_progress')
                      AND due_at IS NOT NULL AND due_at::date = now()::date)                          ::int AS due_today,
             count(*) FILTER (WHERE deleted_at IS NULL AND status = 'completed'
                      AND completed_at >= now() - interval '30 days')                                 ::int AS completed30
           FROM crm_task WHERE shop_id = $1`,
          [ctx.shopId],
        ),
        client.query(
          `SELECT id, branch_id, entity_type, entity_id, type, body, actor_user_id, created_at
             FROM crm_activity
            WHERE shop_id = $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [ctx.shopId],
        ),
      ]);

      const l = leadRes.rows[0];
      const o = oppRes.rows[0];
      const t = taskRes.rows[0];
      return {
        leads: {
          total: l.total,
          new: l.new,
          contacted: l.contacted,
          qualified: l.qualified,
          unqualified: l.unqualified,
          converted: l.converted,
          lost: l.lost,
          last30: l.last30,
        },
        opportunities: {
          open: o.open,
          won: o.won,
          lost: o.lost,
          openValue: Number(o.open_value),
          wonValue: Number(o.won_value),
          wonValue30: Number(o.won_value30),
        },
        tasks: {
          pending: t.pending,
          overdue: t.overdue,
          dueToday: t.due_today,
          completed30: t.completed30,
        },
        recentActivity: rowsToApi(actRes.rows),
      };
    });
    res.json(data);
  } catch (err: any) {
    console.error('[GET /api/crm/dashboard] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load CRM dashboard' });
  }
});

export default router;
