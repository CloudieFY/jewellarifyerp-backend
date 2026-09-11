import { Router, Request, Response } from 'express';
import { withTenant, withSuperAdminCrmTx } from '../../../utils/db';
import { rowToApi, rowsToApi } from '../../../db/mapping';
import { parseListQuery, type ListQueryConfig } from '../../db/listQuery';
import { recordAudit } from '../../audit/recordAudit';
import { enqueueOutbox } from '../../outbox/repository';
import { recordActivity } from '../../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../../leads/repository';
import {
  getOpportunityById,
  insertOpportunity,
  updateOpportunity,
  softDeleteOpportunity,
  OPEN_OPPORTUNITY_STAGES,
  type OpportunityWritable,
} from '../../opportunities/repository';
import { adminActorMeta } from './_shared';

const NUMERIC = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Super Admin CRM Opportunity/Pipeline API — mounted at
 * /api/superadmin/crm/opportunities. Same shape as admin/leads.ts: cross-shop
 * `GET /` reads via withSuperAdminCrmTx; everything else operates on one
 * shop (`:shopId` URL param) via withTenant + the shared
 * src/crm/opportunities/repository.ts functions.
 */

const router = Router();

const OPP_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'title', 'stage', 'amount', 'expected_close_date', 'last_activity_at'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['stage', 'source', 'assigned_to', 'branch_id', 'customer_id', 'lead_id', 'shop_id'],
  searchable: ['title', 'notes'],
  maxLimit: 100,
  defaultLimit: 25,
};

function pickWritable(body: any): Partial<OpportunityWritable> {
  const out: Partial<OpportunityWritable> = {};
  const map: Record<string, keyof OpportunityWritable> = {
    title: 'title', stage: 'stage', amount: 'amount', probability: 'probability', source: 'source', notes: 'notes',
    expectedCloseDate: 'expected_close_date', expected_close_date: 'expected_close_date',
    branchId: 'branch_id', branch_id: 'branch_id', customerId: 'customer_id', customer_id: 'customer_id',
    leadId: 'lead_id', lead_id: 'lead_id',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (!col) continue;
    if (col === 'amount' || col === 'probability') (out as any)[col] = NUMERIC(v);
    else (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* GET /  — cross-shop list                                            */
/* ------------------------------------------------------------------ */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseListQuery(req.query as Record<string, unknown>, OPP_LIST_CONFIG);
  try {
    const { rows, total } = await withSuperAdminCrmTx(async (client) => {
      const { text: whereSql, params } = parsed.buildWhere({ baseConditions: ['deleted_at IS NULL'], baseParams: [] });
      const countRes = await client.query(`SELECT count(*)::int AS total FROM crm_opportunity ${whereSql}`, params);
      const dataRes = await client.query(
        `SELECT sub.*, s.shop_name
           FROM (
             SELECT * FROM crm_opportunity
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
    console.error('[GET /api/superadmin/crm/opportunities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list opportunities' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /pipeline  — cross-shop stage summary                           */
/* ------------------------------------------------------------------ */
router.get('/pipeline', async (_req: Request, res: Response) => {
  try {
    const stages = await withSuperAdminCrmTx(async (client) => {
      const { rows } = await client.query(
        `SELECT stage, count(*)::int AS count, coalesce(sum(amount), 0) AS amount
           FROM crm_opportunity
          WHERE deleted_at IS NULL
          GROUP BY stage`,
      );
      return rows.map((r) => ({ stage: r.stage, count: r.count, amount: Number(r.amount) }));
    });
    const open = stages
      .filter((s) => s.stage !== 'won' && s.stage !== 'lost')
      .reduce((acc, s) => ({ count: acc.count + s.count, amount: acc.amount + s.amount }), { count: 0, amount: 0 });
    res.json({
      stages, open,
      won: stages.find((s) => s.stage === 'won') ?? { stage: 'won', count: 0, amount: 0 },
      lost: stages.find((s) => s.stage === 'lost') ?? { stage: 'lost', count: 0, amount: 0 },
    });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/opportunities/pipeline] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load pipeline' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:shopId/:id                                                     */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id', async (req: Request, res: Response) => {
  try {
    const opp = await withTenant(req.params.shopId, (client) => getOpportunityById(client, req.params.shopId, req.params.id));
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(rowToApi(opp));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/opportunities/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId  — create                                             */
/* ------------------------------------------------------------------ */
router.post('/:shopId', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const data = pickWritable(req.body);
  const assignedToRaw = req.body?.assignedTo ?? req.body?.assigned_to;

  if (!data.title || String(data.title).trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      let branchId: string | null = data.branch_id ?? null;
      if (branchId && !(await branchBelongsToShop(client, shopId, branchId))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }

      const opp = await insertOpportunity(client, { shopId, createdBy: null, data: { ...data, branch_id: branchId, assigned_to: assignedTo } });

      await recordActivity(client, {
        shopId, branchId, entityType: 'opportunity', entityId: opp.id, type: 'system',
        body: 'Opportunity created by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'opportunity', entityId: opp.id, action: 'create', after: opp, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'opportunity.created', payload: { opportunityId: opp.id, assignedTo }, dedupeKey: `opportunity.created:${opp.id}` },
        client,
      );
      return { opp };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/opportunities/:shopId] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:shopId/:id                                                   */
/* ------------------------------------------------------------------ */
router.patch('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to;

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getOpportunityById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      if ('branch_id' in patch && patch.branch_id && !(await branchBelongsToShop(client, shopId, patch.branch_id))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }

      const updated = await updateOpportunity(client, shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'opportunity', entityId: updated.id, type: 'note',
        body: 'Opportunity updated by Super Admin', data: { changed: Object.keys(patch), ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'opportunity', entityId: updated.id, action: 'update', before, after: updated, metadata: adminActorMeta(req) },
        client,
      );
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.opp));
  } catch (err: any) {
    console.error('[PATCH /api/superadmin/crm/opportunities/:shopId/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /:shopId/:id  (soft delete)                                  */
/* ------------------------------------------------------------------ */
router.delete('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getOpportunityById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      const ok = await softDeleteOpportunity(client, shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId, branchId: before.branch_id, entityType: 'opportunity', entityId: before.id, type: 'system',
        body: 'Opportunity deleted by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: before.branch_id, actorUserId: null, entityType: 'opportunity', entityId: before.id, action: 'delete', before, metadata: adminActorMeta(req) },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Opportunity deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/superadmin/crm/opportunities/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/assign                                            */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/assign', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  const branchIdRaw = req.body?.branchId ?? req.body?.branch_id;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getOpportunityById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      if (!(await userBelongsToShop(client, shopId, String(assignedTo)))) {
        return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
      }
      let branchId = before.branch_id;
      if (branchIdRaw) {
        if (!(await branchBelongsToShop(client, shopId, String(branchIdRaw)))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        branchId = String(branchIdRaw);
      }

      const updated = await updateOpportunity(client, shopId, req.params.id, { assigned_to: String(assignedTo), branch_id: branchId, last_activity_at: new Date() });
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId, branchId, entityType: 'opportunity', entityId: updated.id, type: 'assignment',
        body: `Assigned to ${assignedTo} (by Super Admin)`, data: { from: before.assigned_to, to: String(assignedTo), ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'opportunity', entityId: updated.id, action: 'assign', before: { assigned_to: before.assigned_to }, after: { assigned_to: updated.assigned_to }, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'opportunity.assigned', payload: { opportunityId: updated.id, assignedTo: String(assignedTo) }, dedupeKey: `opportunity.assigned:${updated.id}:${assignedTo}` },
        client,
      );
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/opportunities/:shopId/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/stage                                             */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/stage', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const stage = String(req.body?.stage ?? '');
  if (!OPEN_OPPORTUNITY_STAGES.includes(stage as any)) {
    return res.status(400).json({ error: `stage must be one of: ${OPEN_OPPORTUNITY_STAGES.join(', ')} (use /win or /lose to close)` });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getOpportunityById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      if (before.stage === 'won' || before.stage === 'lost') {
        return { err: { status: 409, msg: 'This opportunity is already closed' } };
      }

      const updated = await updateOpportunity(client, shopId, req.params.id, { stage: stage as any, last_activity_at: new Date() });
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'opportunity', entityId: updated.id, type: 'stage_change',
        body: `Stage: ${before.stage} → ${stage} (by Super Admin)`, data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'opportunity', entityId: updated.id, action: 'stage', before: { stage: before.stage }, after: { stage }, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'opportunity.stage_changed', payload: { opportunityId: updated.id, stage, from: before.stage }, dedupeKey: `opportunity.stage_changed:${updated.id}:${stage}` },
        client,
      );
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/opportunities/:shopId/:id/stage] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to change stage' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/win  &  /lose                                     */
/* ------------------------------------------------------------------ */
function closeHandler(kind: 'won' | 'lost') {
  return async (req: Request, res: Response) => {
    const shopId = req.params.shopId;
    const amountRaw = kind === 'won' ? NUMERIC(req.body?.amount) : null;
    const reason = kind === 'lost' && typeof req.body?.reason === 'string' ? req.body.reason : null;

    try {
      const outcome = await withTenant(shopId, async (client) => {
        const before = await getOpportunityById(client, shopId, req.params.id, { forUpdate: true });
        if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
        if (before.stage === 'won' || before.stage === 'lost') {
          return { err: { status: 409, msg: `Opportunity is already ${before.stage}` } };
        }

        const updated = await updateOpportunity(client, shopId, req.params.id, {
          stage: kind, probability: kind === 'won' ? 100 : 0,
          ...(kind === 'won' ? { won_at: new Date(), ...(amountRaw != null ? { amount: amountRaw } : {}) } : { lost_at: new Date(), lost_reason: reason }),
          last_activity_at: new Date(),
        });
        if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

        await recordActivity(client, {
          shopId, branchId: updated.branch_id, entityType: 'opportunity', entityId: updated.id, type: kind === 'won' ? 'won' : 'lost',
          body: (kind === 'won' ? 'Opportunity won' : `Opportunity lost${reason ? ` (${reason})` : ''}`) + ' (by Super Admin)',
          data: { reason, ...adminActorMeta(req) }, actorUserId: null,
        });
        await recordAudit(
          { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'opportunity', entityId: updated.id, action: kind === 'won' ? 'win' : 'lose', before: { stage: before.stage }, after: { stage: kind }, metadata: { reason, amount: updated.amount, ...adminActorMeta(req) } },
          client,
        );
        await enqueueOutbox(
          { shopId, eventType: kind === 'won' ? 'opportunity.won' : 'opportunity.lost', payload: { opportunityId: updated.id, amount: updated.amount, reason }, dedupeKey: `opportunity.${kind}:${updated.id}` },
          client,
        );
        return { opp: updated };
      });

      if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
      res.json(rowToApi(outcome.opp));
    } catch (err: any) {
      console.error(`[POST /api/superadmin/crm/opportunities/:shopId/:id/${kind === 'won' ? 'win' : 'lose'}] failed:`, err?.message || err);
      res.status(400).json({ error: err?.message || `Failed to mark opportunity ${kind}` });
    }
  };
}
router.post('/:shopId/:id/win', closeHandler('won'));
router.post('/:shopId/:id/lose', closeHandler('lost'));

export default router;
