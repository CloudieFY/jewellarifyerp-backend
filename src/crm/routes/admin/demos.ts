import { Router, Request, Response } from 'express';
import { withTenant, withSuperAdminCrmTx } from '../../../utils/db';
import { rowToApi, rowsToApi } from '../../../db/mapping';
import { parseListQuery, type ListQueryConfig } from '../../db/listQuery';
import { recordAudit } from '../../audit/recordAudit';
import { enqueueOutbox } from '../../outbox/repository';
import { recordActivity, listActivity, type ActivityType } from '../../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../../leads/repository';
import { leadBelongsToShop, opportunityBelongsToShop, customerBelongsToShop } from '../../opportunities/repository';
import {
  getDemoById,
  insertDemo,
  updateDemo,
  type DemoWritable,
} from '../../demos/repository';
import { adminActorMeta } from './_shared';

/**
 * Super Admin CRM Demo API — mounted at /api/superadmin/crm/demos. Same
 * shape as admin/leads.ts: cross-shop `GET /` reads via withSuperAdminCrmTx;
 * everything else operates on one shop (`:shopId` URL param) via
 * withTenant + src/crm/demos/repository.ts.
 */

const router = Router();

const DEMO_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'scheduled_at', 'status'],
  defaultSort: { column: 'scheduled_at', direction: 'DESC' },
  filterable: ['status', 'assigned_to', 'branch_id', 'lead_id', 'opportunity_id', 'customer_id', 'shop_id'],
  searchable: ['notes', 'mode'],
  maxLimit: 100,
  defaultLimit: 25,
};

function pickWritable(body: any): Partial<DemoWritable> {
  const out: Partial<DemoWritable> = {};
  const map: Record<string, keyof DemoWritable> = {
    branchId: 'branch_id', branch_id: 'branch_id',
    leadId: 'lead_id', lead_id: 'lead_id',
    opportunityId: 'opportunity_id', opportunity_id: 'opportunity_id',
    customerId: 'customer_id', customer_id: 'customer_id',
    scheduledAt: 'scheduled_at', scheduled_at: 'scheduled_at',
    mode: 'mode',
    notes: 'notes',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (col) (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

/** Validate any lead_id/opportunity_id/customer_id/branch_id present in `data` belong to this shop. */
async function validateRefs(client: any, shopId: string, data: Partial<DemoWritable>): Promise<string | null> {
  if (data.branch_id && !(await branchBelongsToShop(client, shopId, data.branch_id))) {
    return 'branch_id does not belong to this shop';
  }
  if (data.lead_id && !(await leadBelongsToShop(client, shopId, data.lead_id))) {
    return 'lead_id does not belong to this shop';
  }
  if (data.opportunity_id && !(await opportunityBelongsToShop(client, shopId, data.opportunity_id))) {
    return 'opportunity_id does not belong to this shop';
  }
  if (data.customer_id && !(await customerBelongsToShop(client, shopId, data.customer_id))) {
    return 'customer_id does not belong to this shop';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* GET /  — cross-shop list                                            */
/* ------------------------------------------------------------------ */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseListQuery(req.query as Record<string, unknown>, DEMO_LIST_CONFIG);
  try {
    const { rows, total } = await withSuperAdminCrmTx(async (client) => {
      const { text: whereSql, params } = parsed.buildWhere({ baseConditions: ['deleted_at IS NULL'], baseParams: [] });
      const countRes = await client.query(`SELECT count(*)::int AS total FROM crm_demo ${whereSql}`, params);
      const dataRes = await client.query(
        `SELECT sub.*, s.shop_name
           FROM (
             SELECT * FROM crm_demo
             ${whereSql}
             ORDER BY ${parsed.orderBy.column} ${parsed.orderBy.direction} NULLS LAST, id ASC
             LIMIT ${parsed.limit} OFFSET ${parsed.offset}
           ) sub
           JOIN shops s ON s.id = sub.shop_id`,
        params,
      );
      return { rows: dataRes.rows, total: countRes.rows[0].total as number };
    });
    res.json({ data: rowsToApi(rows), page: parsed.page, limit: parsed.limit, total, totalPages: Math.max(1, Math.ceil(total / parsed.limit)) });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/demos] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list demos' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:shopId/:id                                                     */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id', async (req: Request, res: Response) => {
  try {
    const demo = await withTenant(req.params.shopId, (client) => getDemoById(client, req.params.shopId, req.params.id));
    if (!demo) return res.status(404).json({ error: 'Demo not found' });
    res.json(rowToApi(demo));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/demos/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch demo' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId  — schedule a demo                                    */
/* ------------------------------------------------------------------ */
router.post('/:shopId', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const data = pickWritable(req.body);
  const assignedToRaw = req.body?.assignedTo ?? req.body?.assigned_to;

  if (!data.scheduled_at) {
    return res.status(400).json({ error: 'scheduledAt is required' });
  }
  if (!data.lead_id && !data.opportunity_id) {
    return res.status(400).json({ error: 'leadId or opportunityId is required' });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const refErr = await validateRefs(client, shopId, data);
      if (refErr) return { err: { status: 400, msg: refErr } };

      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }

      const demo = await insertDemo(client, { shopId, createdBy: null, data: { ...data, assigned_to: assignedTo } });

      await recordActivity(client, {
        shopId, branchId: demo.branch_id, entityType: 'demo', entityId: demo.id, type: 'system',
        body: 'Demo scheduled by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: demo.branch_id, actorUserId: null, entityType: 'demo', entityId: demo.id, action: 'create', after: demo, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'demo.scheduled', payload: { demoId: demo.id, scheduledAt: demo.scheduled_at }, dedupeKey: `demo.scheduled:${demo.id}` },
        client,
      );
      return { demo };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.demo));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/demos/:shopId] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to schedule demo' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:shopId/:id                                                   */
/* ------------------------------------------------------------------ */
router.patch('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const patch = pickWritable(req.body);

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getDemoById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Demo not found' } };
      if (before.status !== 'scheduled') {
        return { err: { status: 409, msg: `Cannot edit a demo that is already ${before.status}` } };
      }
      const refErr = await validateRefs(client, shopId, patch);
      if (refErr) return { err: { status: 400, msg: refErr } };
      if ('lead_id' in patch && !patch.lead_id && !(patch.opportunity_id ?? before.opportunity_id)) {
        return { err: { status: 400, msg: 'leadId or opportunityId is required' } };
      }
      if ('opportunity_id' in patch && !patch.opportunity_id && !(patch.lead_id ?? before.lead_id)) {
        return { err: { status: 400, msg: 'leadId or opportunityId is required' } };
      }

      const updated = await updateDemo(client, shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Demo not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'demo', entityId: updated.id, type: 'note',
        body: 'Demo updated by Super Admin', data: { changed: Object.keys(patch), ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'demo', entityId: updated.id, action: 'update', before, after: updated, metadata: adminActorMeta(req) },
        client,
      );
      return { demo: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.demo));
  } catch (err: any) {
    console.error('[PATCH /api/superadmin/crm/demos/:shopId/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update demo' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/assign                                            */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/assign', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getDemoById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Demo not found' } };
      if (!(await userBelongsToShop(client, shopId, String(assignedTo)))) {
        return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
      }

      const updated = await updateDemo(client, shopId, req.params.id, { assigned_to: String(assignedTo), last_activity_at: new Date() });
      if (!updated) return { err: { status: 404, msg: 'Demo not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'demo', entityId: updated.id, type: 'assignment',
        body: `Assigned to ${assignedTo} (by Super Admin)`, data: { from: before.assigned_to, to: String(assignedTo), ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'demo', entityId: updated.id, action: 'assign', before: { assigned_to: before.assigned_to }, after: { assigned_to: updated.assigned_to }, metadata: adminActorMeta(req) },
        client,
      );
      return { demo: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.demo));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/demos/:shopId/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign demo' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/complete                                          */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/complete', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const outcomeVal = typeof req.body?.outcome === 'string' ? req.body.outcome.trim() : null;
  const nextAction = typeof req.body?.nextAction === 'string' ? req.body.nextAction.trim() : null;
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;
  if (!outcomeVal) return res.status(400).json({ error: 'outcome is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getDemoById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Demo not found' } };
      if (before.status !== 'scheduled') {
        return { err: { status: 409, msg: `Demo is already ${before.status}` } };
      }

      const updated = await updateDemo(client, shopId, req.params.id, {
        status: 'completed', outcome: outcomeVal, next_action: nextAction,
        notes: notes ?? before.notes, completed_at: new Date(), last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Demo not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'demo', entityId: updated.id, type: 'completion',
        body: `Demo completed by Super Admin — outcome: ${outcomeVal}`,
        data: { outcome: outcomeVal, nextAction, ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'demo', entityId: updated.id, action: 'complete', before: { status: before.status }, after: { status: 'completed', outcome: outcomeVal }, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'demo.completed', payload: { demoId: updated.id, outcome: outcomeVal }, dedupeKey: `demo.completed:${updated.id}` },
        client,
      );
      return { demo: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.demo));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/demos/:shopId/:id/complete] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to complete demo' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/cancel                                            */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/cancel', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : null;
  const asNoShow = req.body?.noShow === true;

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getDemoById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Demo not found' } };
      if (before.status !== 'scheduled') {
        return { err: { status: 409, msg: `Demo is already ${before.status}` } };
      }

      const newStatus = asNoShow ? 'no_show' : 'cancelled';
      const updated = await updateDemo(client, shopId, req.params.id, {
        status: newStatus,
        notes: reason ? `${before.notes ? before.notes + ' — ' : ''}${reason}` : before.notes,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Demo not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'demo', entityId: updated.id, type: 'status_change',
        body: `Demo marked ${newStatus} by Super Admin${reason ? ` (${reason})` : ''}`,
        data: { reason, ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'demo', entityId: updated.id, action: 'cancel', before: { status: before.status }, after: { status: newStatus }, metadata: { reason, ...adminActorMeta(req) } },
        client,
      );
      return { demo: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.demo));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/demos/:shopId/:id/cancel] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to cancel demo' });
  }
});

/* ------------------------------------------------------------------ */
/* GET / POST /:shopId/:id/activities                                  */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id/activities', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const payload = await withTenant(shopId, async (client) => {
      const demo = await getDemoById(client, shopId, req.params.id);
      if (!demo) return null;
      const { rows, total } = await listActivity(client, shopId, 'demo', req.params.id, { limit, offset });
      return { rows, total };
    });
    if (!payload) return res.status(404).json({ error: 'Demo not found' });
    res.json({ data: rowsToApi(payload.rows), total: payload.total, limit, offset });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/demos/:shopId/:id/activities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/:shopId/:id/activities', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const allowedTypes: ActivityType[] = ['note', 'call', 'email', 'meeting'];
  const type: ActivityType = allowedTypes.includes(req.body?.type) ? req.body.type : 'note';
  if (!body) return res.status(400).json({ error: 'body is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const demo = await getDemoById(client, shopId, req.params.id, { forUpdate: true });
      if (!demo) return { err: { status: 404, msg: 'Demo not found' } };

      const activity = await recordActivity(client, {
        shopId, branchId: demo.branch_id, entityType: 'demo', entityId: demo.id, type,
        body: `${body} (Super Admin)`, data: adminActorMeta(req), actorUserId: null,
      });
      await updateDemo(client, shopId, demo.id, { last_activity_at: new Date() });
      return { activity };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.activity));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/demos/:shopId/:id/activities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to add activity' });
  }
});

export default router;
