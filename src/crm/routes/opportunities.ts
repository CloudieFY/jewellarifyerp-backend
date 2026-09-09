import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowToApi, rowsToApi } from '../../db/mapping';
import { requireCrmPermission } from '../middleware/requireCrmPermission';
import { parseListQuery, assertNoClientShopScope, type ListQueryConfig } from '../db/listQuery';
import { recordAudit } from '../audit/recordAudit';
import { enqueueOutbox } from '../outbox/repository';
import { recordActivity, listActivity, type ActivityType } from '../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../leads/repository';
import {
  listOpportunities,
  getOpportunityById,
  insertOpportunity,
  updateOpportunity,
  softDeleteOpportunity,
  pipelineSummary,
  leadBelongsToShop,
  customerBelongsToShop,
  OPPORTUNITY_STAGES,
  OPEN_OPPORTUNITY_STAGES,
  type OpportunityScope,
  type OpportunityRow,
  type OpportunityWritable,
} from '../opportunities/repository';
import type { PgTenantContext } from '../../middleware/authPg';
import type { PoolClient } from 'pg';

/**
 * CRM Opportunity / Pipeline API — mounted at /api/crm/opportunities by
 * src/crm/routes/index.ts.
 *
 * Every route mirrors the Phase 1 lead routes:
 *   - gated by requireCrmPermission('opportunity', <action>) (server-enforced,
 *     re-checked against live DB state on every request);
 *   - takes shop_id ONLY from req.pgTenant.shopId — client shop_id is rejected
 *     by assertNoClientShopScope();
 *   - runs inside withTenant() so crm_opportunity RLS is active;
 *   - applies the caller's branch / dealer scope server-side;
 *   - writes an audit row, an activity row and (where relevant) an outbox event.
 */

const router = Router();

const OPP_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'title', 'stage', 'amount', 'expected_close_date', 'last_activity_at'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['stage', 'source', 'assigned_to', 'branch_id', 'customer_id', 'lead_id'],
  searchable: ['title', 'notes'],
  maxLimit: 100,
  defaultLimit: 25,
};

function guardShopScope(req: Request, res: Response): boolean {
  try {
    assertNoClientShopScope(req.body as Record<string, unknown>);
    assertNoClientShopScope(req.query as Record<string, unknown>);
    return true;
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Invalid request scope' });
    return false;
  }
}

const NUMERIC = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** camelCase body -> snake_case writable subset (allow-listed keys only). */
function pickWritable(body: any): Partial<OpportunityWritable> {
  const out: Partial<OpportunityWritable> = {};
  const map: Record<string, keyof OpportunityWritable> = {
    title: 'title',
    stage: 'stage',
    amount: 'amount',
    probability: 'probability',
    source: 'source',
    notes: 'notes',
    expectedCloseDate: 'expected_close_date',
    expected_close_date: 'expected_close_date',
    branchId: 'branch_id',
    branch_id: 'branch_id',
    customerId: 'customer_id',
    customer_id: 'customer_id',
    leadId: 'lead_id',
    lead_id: 'lead_id',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (!col) continue;
    if (col === 'amount' || col === 'probability') (out as any)[col] = NUMERIC(v);
    else (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

async function resolveOppScope(client: PoolClient, ctx: PgTenantContext): Promise<OpportunityScope> {
  const { rows } = await client.query(
    `SELECT branch_id FROM user_branches WHERE shop_id = $1 AND user_id = $2`,
    [ctx.shopId, ctx.user.id],
  );
  const branchIds = rows.map((r) => r.branch_id as string);
  return {
    userId: ctx.user.id,
    branchIds: branchIds.length ? branchIds : null,
    ownOnly: ctx.crmRole === 'dealer',
  };
}

function branchInScope(scope: OpportunityScope, branchId: string | null | undefined): boolean {
  if (!scope.branchIds) return true;
  if (!branchId) return false;
  return scope.branchIds.includes(branchId);
}

const serialize = (row: OpportunityRow) => rowToApi(row);

/* ------------------------------------------------------------------ */
/* GET /api/crm/opportunities                                          */
/* ------------------------------------------------------------------ */
router.get('/', ...requireCrmPermission('opportunity', 'view'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const parsed = parseListQuery(req.query as Record<string, unknown>, OPP_LIST_CONFIG);
  try {
    const { rows, total } = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      return listOpportunities(client, { shopId: ctx.shopId, scope, parsed });
    });
    res.json({
      data: rowsToApi(rows),
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
    });
  } catch (err: any) {
    console.error('[GET /api/crm/opportunities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list opportunities' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/opportunities/pipeline  (stage summary for the board)  */
/* ------------------------------------------------------------------ */
router.get('/pipeline', ...requireCrmPermission('opportunity', 'view'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
  const assignedTo = typeof req.query.assigned_to === 'string' ? req.query.assigned_to : null;
  try {
    const stages = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      return pipelineSummary(client, { shopId: ctx.shopId, scope, branchId, assignedTo });
    });
    const open = stages
      .filter((s) => s.stage !== 'won' && s.stage !== 'lost')
      .reduce((acc, s) => ({ count: acc.count + s.count, amount: acc.amount + s.amount }), { count: 0, amount: 0 });
    res.json({
      stages,
      open,
      won: stages.find((s) => s.stage === 'won') ?? { stage: 'won', count: 0, amount: 0 },
      lost: stages.find((s) => s.stage === 'lost') ?? { stage: 'lost', count: 0, amount: 0 },
    });
  } catch (err: any) {
    console.error('[GET /api/crm/opportunities/pipeline] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load pipeline' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/opportunities/:id                                      */
/* ------------------------------------------------------------------ */
router.get('/:id', ...requireCrmPermission('opportunity', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const opp = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      return getOpportunityById(client, ctx.shopId, req.params.id, { scope });
    });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(serialize(opp));
  } catch (err: any) {
    console.error('[GET /api/crm/opportunities/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/opportunities                                         */
/* ------------------------------------------------------------------ */
router.post('/', ...requireCrmPermission('opportunity', 'create'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const data = pickWritable(req.body);
  const assignedToRaw = req.body?.assignedTo ?? req.body?.assigned_to;

  if (!data.title || String(data.title).trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (data.stage && !OPPORTUNITY_STAGES.includes(data.stage as any)) {
    return res.status(400).json({ error: `stage must be one of: ${OPPORTUNITY_STAGES.join(', ')}` });
  }
  if (data.stage && !OPEN_OPPORTUNITY_STAGES.includes(data.stage as any)) {
    return res.status(400).json({ error: 'A new opportunity must start in an open stage — use /win or /lose to close it' });
  }
  if (data.probability != null && (data.probability < 0 || data.probability > 100)) {
    return res.status(400).json({ error: 'probability must be between 0 and 100' });
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);

      const branchId: string | null = data.branch_id ?? null;
      if (branchId && !(await branchBelongsToShop(client, ctx.shopId, branchId))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      if (!branchInScope(scope, branchId)) {
        return { err: { status: 403, msg: 'You can only create opportunities within your assigned branch(es)' } };
      }
      if (data.customer_id && !(await customerBelongsToShop(client, ctx.shopId, String(data.customer_id)))) {
        return { err: { status: 400, msg: 'customerId does not belong to this shop' } };
      }
      if (data.lead_id && !(await leadBelongsToShop(client, ctx.shopId, String(data.lead_id)))) {
        return { err: { status: 400, msg: 'leadId does not belong to this shop' } };
      }

      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, ctx.shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }
      if (ctx.crmRole === 'dealer') assignedTo = ctx.user.id;

      const opp = await insertOpportunity(client, {
        shopId: ctx.shopId,
        createdBy: ctx.user.id,
        data: { ...data, branch_id: branchId, assigned_to: assignedTo },
      });

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId,
        entityType: 'opportunity',
        entityId: opp.id,
        type: 'system',
        body: 'Opportunity created',
        actorUserId: ctx.user.id,
      });
      if (opp.lead_id) {
        await recordActivity(client, {
          shopId: ctx.shopId,
          branchId,
          entityType: 'lead',
          entityId: opp.lead_id,
          type: 'system',
          body: 'Opportunity created from this lead',
          data: { opportunityId: opp.id },
          actorUserId: ctx.user.id,
        });
      }
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId,
          actorUserId: ctx.user.id,
          entityType: 'opportunity',
          entityId: opp.id,
          action: 'create',
          after: opp,
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'opportunity.created',
          payload: { opportunityId: opp.id, assignedTo },
          dedupeKey: `opportunity.created:${opp.id}`,
        },
        client,
      );
      return { opp };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(serialize(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/crm/opportunities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH / PUT /api/crm/opportunities/:id                              */
/* ------------------------------------------------------------------ */
async function handleUpdate(req: Request, res: Response) {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to; // assignment has its own endpoint/permission

  if ('title' in patch && (!patch.title || String(patch.title).trim().length === 0)) {
    return res.status(400).json({ error: 'title cannot be empty' });
  }
  if (patch.stage && !OPPORTUNITY_STAGES.includes(patch.stage as any)) {
    return res.status(400).json({ error: `stage must be one of: ${OPPORTUNITY_STAGES.join(', ')}` });
  }
  if (patch.stage && !OPEN_OPPORTUNITY_STAGES.includes(patch.stage as any)) {
    return res.status(400).json({ error: 'Set stage "won"/"lost" via the /win or /lose endpoint only' });
  }
  if (patch.probability != null && (patch.probability < 0 || patch.probability > 100)) {
    return res.status(400).json({ error: 'probability must be between 0 and 100' });
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const before = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      if (before.stage === 'won' || before.stage === 'lost') {
        return { err: { status: 409, msg: 'This opportunity is closed; reopen is not supported in this phase' } };
      }

      if ('branch_id' in patch && patch.branch_id) {
        if (!(await branchBelongsToShop(client, ctx.shopId, patch.branch_id))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        if (!branchInScope(scope, patch.branch_id)) {
          return { err: { status: 403, msg: 'That branch is outside your scope' } };
        }
      }
      if ('customer_id' in patch && patch.customer_id) {
        if (!(await customerBelongsToShop(client, ctx.shopId, String(patch.customer_id)))) {
          return { err: { status: 400, msg: 'customerId does not belong to this shop' } };
        }
      }
      if ('lead_id' in patch && patch.lead_id) {
        if (!(await leadBelongsToShop(client, ctx.shopId, String(patch.lead_id)))) {
          return { err: { status: 400, msg: 'leadId does not belong to this shop' } };
        }
      }

      const stageChanged = patch.stage && patch.stage !== before.stage;
      const updated = await updateOpportunity(client, ctx.shopId, req.params.id, {
        ...patch,
        ...(stageChanged ? { last_activity_at: new Date() } : {}),
      });
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: updated.branch_id,
        entityType: 'opportunity',
        entityId: updated.id,
        type: stageChanged ? 'stage_change' : 'note',
        body: stageChanged ? `Stage: ${before.stage} → ${patch.stage}` : 'Opportunity updated',
        data: { changed: Object.keys(patch) },
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'opportunity',
          entityId: updated.id,
          action: 'update',
          before,
          after: updated,
        },
        client,
      );
      if (stageChanged) {
        await enqueueOutbox(
          {
            shopId: ctx.shopId,
            eventType: 'opportunity.stage_changed',
            payload: { opportunityId: updated.id, stage: patch.stage, from: before.stage },
            dedupeKey: `opportunity.stage_changed:${updated.id}:${patch.stage}`,
          },
          client,
        );
      }
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.opp));
  } catch (err: any) {
    console.error('[PATCH /api/crm/opportunities/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update opportunity' });
  }
}
router.patch('/:id', ...requireCrmPermission('opportunity', 'update'), handleUpdate);
router.put('/:id', ...requireCrmPermission('opportunity', 'update'), handleUpdate);

/* ------------------------------------------------------------------ */
/* POST /api/crm/opportunities/:id/stage                               */
/* ------------------------------------------------------------------ */
router.post('/:id/stage', ...requireCrmPermission('opportunity', 'stage'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const stage = String(req.body?.stage ?? '');
  if (!OPEN_OPPORTUNITY_STAGES.includes(stage as any)) {
    return res.status(400).json({ error: `stage must be one of: ${OPEN_OPPORTUNITY_STAGES.join(', ')} (use /win or /lose to close)` });
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const before = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
      if (before.stage === 'won' || before.stage === 'lost') {
        return { err: { status: 409, msg: 'This opportunity is already closed' } };
      }

      const updated = await updateOpportunity(client, ctx.shopId, req.params.id, {
        stage: stage as any,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: updated.branch_id,
        entityType: 'opportunity',
        entityId: updated.id,
        type: 'stage_change',
        body: `Stage: ${before.stage} → ${stage}`,
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'opportunity',
          entityId: updated.id,
          action: 'stage',
          before: { stage: before.stage },
          after: { stage },
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'opportunity.stage_changed',
          payload: { opportunityId: updated.id, stage, from: before.stage },
          dedupeKey: `opportunity.stage_changed:${updated.id}:${stage}`,
        },
        client,
      );
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/crm/opportunities/:id/stage] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to change stage' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/opportunities/:id/assign                              */
/* ------------------------------------------------------------------ */
router.post('/:id/assign', ...requireCrmPermission('opportunity', 'assign'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  const branchIdRaw = req.body?.branchId ?? req.body?.branch_id;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const before = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };

      if (!(await userBelongsToShop(client, ctx.shopId, String(assignedTo)))) {
        return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
      }
      let branchId = before.branch_id;
      if (branchIdRaw) {
        if (!(await branchBelongsToShop(client, ctx.shopId, String(branchIdRaw)))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        if (!branchInScope(scope, String(branchIdRaw))) {
          return { err: { status: 403, msg: 'That branch is outside your scope' } };
        }
        branchId = String(branchIdRaw);
      }

      const updated = await updateOpportunity(client, ctx.shopId, req.params.id, {
        assigned_to: String(assignedTo),
        branch_id: branchId,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId,
        entityType: 'opportunity',
        entityId: updated.id,
        type: 'assignment',
        body: `Assigned to ${assignedTo}`,
        data: { from: before.assigned_to, to: String(assignedTo) },
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId,
          actorUserId: ctx.user.id,
          entityType: 'opportunity',
          entityId: updated.id,
          action: 'assign',
          before: { assigned_to: before.assigned_to },
          after: { assigned_to: updated.assigned_to },
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'opportunity.assigned',
          payload: { opportunityId: updated.id, assignedTo: String(assignedTo), assignedBy: ctx.user.id },
          dedupeKey: `opportunity.assigned:${updated.id}:${assignedTo}`,
        },
        client,
      );
      return { opp: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.opp));
  } catch (err: any) {
    console.error('[POST /api/crm/opportunities/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/opportunities/:id/win  &  /lose                       */
/* ------------------------------------------------------------------ */
function closeHandler(kind: 'won' | 'lost') {
  return async (req: Request, res: Response) => {
    if (!guardShopScope(req, res)) return;
    const ctx = req.pgTenant!;
    const amountRaw = kind === 'won' ? NUMERIC(req.body?.amount) : null;
    const reason = kind === 'lost' && typeof req.body?.reason === 'string' ? req.body.reason : null;

    try {
      const outcome = await withTenant(ctx.shopId, async (client) => {
        const scope = await resolveOppScope(client, ctx);
        const before = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
        if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };
        if (before.stage === 'won' || before.stage === 'lost') {
          return { err: { status: 409, msg: `Opportunity is already ${before.stage}` } };
        }

        const updated = await updateOpportunity(client, ctx.shopId, req.params.id, {
          stage: kind,
          probability: kind === 'won' ? 100 : 0,
          ...(kind === 'won'
            ? { won_at: new Date(), ...(amountRaw != null ? { amount: amountRaw } : {}) }
            : { lost_at: new Date(), lost_reason: reason }),
          last_activity_at: new Date(),
        });
        if (!updated) return { err: { status: 404, msg: 'Opportunity not found' } };

        await recordActivity(client, {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          entityType: 'opportunity',
          entityId: updated.id,
          type: kind === 'won' ? 'won' : 'lost',
          body: kind === 'won' ? 'Opportunity won' : `Opportunity lost${reason ? ` (${reason})` : ''}`,
          data: { reason },
          actorUserId: ctx.user.id,
        });
        await recordAudit(
          {
            shopId: ctx.shopId,
            branchId: updated.branch_id,
            actorUserId: ctx.user.id,
            entityType: 'opportunity',
            entityId: updated.id,
            action: kind === 'won' ? 'win' : 'lose',
            before: { stage: before.stage },
            after: { stage: kind },
            metadata: { reason, amount: updated.amount },
          },
          client,
        );
        await enqueueOutbox(
          {
            shopId: ctx.shopId,
            eventType: kind === 'won' ? 'opportunity.won' : 'opportunity.lost',
            payload: { opportunityId: updated.id, amount: updated.amount, reason },
            dedupeKey: `opportunity.${kind}:${updated.id}`,
          },
          client,
        );
        return { opp: updated };
      });

      if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
      res.json(serialize(outcome.opp));
    } catch (err: any) {
      console.error(`[POST /api/crm/opportunities/:id/${kind === 'won' ? 'win' : 'lose'}] failed:`, err?.message || err);
      res.status(400).json({ error: err?.message || `Failed to mark opportunity ${kind}` });
    }
  };
}
router.post('/:id/win', ...requireCrmPermission('opportunity', 'win'), closeHandler('won'));
router.post('/:id/lose', ...requireCrmPermission('opportunity', 'lose'), closeHandler('lost'));

/* ------------------------------------------------------------------ */
/* DELETE /api/crm/opportunities/:id   (soft delete)                   */
/* ------------------------------------------------------------------ */
router.delete('/:id', ...requireCrmPermission('opportunity', 'delete'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const before = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Opportunity not found' } };

      const ok = await softDeleteOpportunity(client, ctx.shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Opportunity not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: before.branch_id,
        entityType: 'opportunity',
        entityId: before.id,
        type: 'system',
        body: 'Opportunity deleted',
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: before.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'opportunity',
          entityId: before.id,
          action: 'delete',
          before,
        },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Opportunity deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/crm/opportunities/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete opportunity' });
  }
});

/* ------------------------------------------------------------------ */
/* GET / POST /api/crm/opportunities/:id/activities                    */
/* ------------------------------------------------------------------ */
router.get('/:id/activities', ...requireCrmPermission('opportunity', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const payload = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const opp = await getOpportunityById(client, ctx.shopId, req.params.id, { scope });
      if (!opp) return null;
      return listActivity(client, ctx.shopId, 'opportunity', req.params.id, { limit, offset });
    });
    if (!payload) return res.status(404).json({ error: 'Opportunity not found' });
    res.json({ data: rowsToApi(payload.rows), total: payload.total, limit, offset });
  } catch (err: any) {
    console.error('[GET /api/crm/opportunities/:id/activities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/:id/activities', ...requireCrmPermission('opportunity', 'update'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const allowedTypes: ActivityType[] = ['note', 'call', 'email', 'meeting'];
  const type: ActivityType = allowedTypes.includes(req.body?.type) ? req.body.type : 'note';
  if (!body) return res.status(400).json({ error: 'body is required' });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveOppScope(client, ctx);
      const opp = await getOpportunityById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!opp) return { err: { status: 404, msg: 'Opportunity not found' } };

      const activity = await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: opp.branch_id,
        entityType: 'opportunity',
        entityId: opp.id,
        type,
        body,
        actorUserId: ctx.user.id,
      });
      await updateOpportunity(client, ctx.shopId, opp.id, { last_activity_at: new Date() });
      return { activity };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.activity));
  } catch (err: any) {
    console.error('[POST /api/crm/opportunities/:id/activities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to add activity' });
  }
});

export default router;
