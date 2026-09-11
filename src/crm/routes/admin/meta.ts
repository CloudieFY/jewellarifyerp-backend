import { Router, Request, Response } from 'express';
import { withSuperAdminCrmTx } from '../../../utils/db';
import { rowsToApi } from '../../../db/mapping';

/**
 * Super Admin CRM meta endpoints — mounted at /api/superadmin/crm by
 * src/crm/routes/admin/index.ts.
 *
 *   GET /shops      — every shop, for the shop picker / list "Shop" column
 *   GET /dashboard   — cross-shop lead / opportunity / task rollups, grouped
 *                       per shop plus a totals row (mirrors the shape of the
 *                       tenant GET /api/crm/dashboard, extended across shops)
 */

const router = Router();

router.get('/shops', async (_req: Request, res: Response) => {
  try {
    const rows = await withSuperAdminCrmTx(async (client) => {
      const { rows } = await client.query(
        `SELECT id, shop_name, plan FROM shops ORDER BY shop_name ASC`,
      );
      return rows;
    });
    res.json(rowsToApi(rows));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/shops] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list shops' });
  }
});

router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const data = await withSuperAdminCrmTx(async (client) => {
      const [leadRes, oppRes, taskRes, byShopRes, actRes] = await Promise.all([
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
           FROM crm_lead`,
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
           FROM crm_opportunity`,
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
           FROM crm_task`,
        ),
        client.query(
          `SELECT s.id AS shop_id, s.shop_name,
                  count(l.*) FILTER (WHERE l.deleted_at IS NULL)                       ::int AS lead_count,
                  count(o.*) FILTER (WHERE o.deleted_at IS NULL AND o.stage NOT IN ('won','lost')) ::int AS open_opportunity_count,
                  coalesce(sum(o.amount) FILTER (WHERE o.deleted_at IS NULL AND o.stage = 'won'), 0) AS won_value
             FROM shops s
             LEFT JOIN crm_lead l ON l.shop_id = s.id
             LEFT JOIN crm_opportunity o ON o.shop_id = s.id
            GROUP BY s.id, s.shop_name
            ORDER BY s.shop_name ASC`,
        ),
        client.query(
          `SELECT a.id, a.shop_id, s.shop_name, a.branch_id, a.entity_type, a.entity_id, a.type, a.body, a.actor_user_id, a.created_at
             FROM crm_activity a
             JOIN shops s ON s.id = a.shop_id
            ORDER BY a.created_at DESC
            LIMIT 30`,
        ),
      ]);

      const l = leadRes.rows[0];
      const o = oppRes.rows[0];
      const t = taskRes.rows[0];
      return {
        leads: {
          total: l.total, new: l.new, contacted: l.contacted, qualified: l.qualified,
          unqualified: l.unqualified, converted: l.converted, lost: l.lost, last30: l.last30,
        },
        opportunities: {
          open: o.open, won: o.won, lost: o.lost,
          openValue: Number(o.open_value), wonValue: Number(o.won_value), wonValue30: Number(o.won_value30),
        },
        tasks: {
          pending: t.pending, overdue: t.overdue, dueToday: t.due_today, completed30: t.completed30,
        },
        byShop: byShopRes.rows.map((r) => ({
          shopId: r.shop_id,
          shopName: r.shop_name,
          leadCount: r.lead_count,
          openOpportunityCount: r.open_opportunity_count,
          wonValue: Number(r.won_value),
        })),
        recentActivity: rowsToApi(actRes.rows),
      };
    });
    res.json(data);
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/dashboard] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load CRM dashboard' });
  }
});

export default router;
