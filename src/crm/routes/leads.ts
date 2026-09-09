import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowToApi, rowsToApi } from '../../db/mapping';
import { requireCrmPermission } from '../middleware/requireCrmPermission';
import { parseListQuery, assertNoClientShopScope, type ListQueryConfig } from '../db/listQuery';
import { recordAudit } from '../audit/recordAudit';
import { enqueueOutbox } from '../outbox/repository';
import { recordActivity, listActivity, type ActivityType } from '../activity/repository';
import { convertLead } from '../leads/service';
import {
  listLeads,
  getLeadById,
  insertLead,
  updateLead,
  softDeleteLead,
  branchBelongsToShop,
  userBelongsToShop,
  LEAD_STATUSES,
  type LeadScope,
  type LeadRow,
  type LeadWritable,
} from '../leads/repository';
import type { PgTenantContext } from '../../middleware/authPg';
import type { PoolClient } from 'pg';

/**
 * CRM Lead API — mounted at /api/crm/leads by src/crm/routes/index.ts.
 *
 * Every route:
 *   - is gated by requireCrmPermission('lead', <action>) (server-enforced,
 *     re-checked against live DB state on every request);
 *   - takes shop_id ONLY from req.pgTenant.shopId (verified JWT) — client
 *     shop_id is rejected by assertNoClientShopScope();
 *   - runs inside withTenant() so crm_lead RLS is active;
 *   - applies the caller's branch / dealer scope server-side;
 *   - writes an audit row and (where relevant) an outbox event.
 */

const router = Router();

const LEAD_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'name', 'status', 'last_activity_at'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['status', 'source', 'assigned_to', 'branch_id'],
  searchable: ['name', 'phone', 'email', 'company'],
  maxLimit: 100,
  defaultLimit: 25,
};

const WRITABLE_KEYS: Array<keyof LeadWritable> = [
  'name',
  'phone',
  'email',
  'company',
  'source',
  'status',
  'notes',
  'branch_id',
];

/** Reject any client-supplied shop scope; returns true if the request is clean. */
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

/** camelCase body -> snake_case writable subset (allow-listed keys only). */
function pickWritable(body: any): Partial<LeadWritable> {
  const out: Partial<LeadWritable> = {};
  const map: Record<string, keyof LeadWritable> = {
    name: 'name',
    phone: 'phone',
    email: 'email',
    company: 'company',
    source: 'source',
    status: 'status',
    notes: 'notes',
    branchId: 'branch_id',
    branch_id: 'branch_id',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (col && WRITABLE_KEYS.includes(col)) (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

async function resolveLeadScope(
  client: PoolClient,
  ctx: PgTenantContext,
): Promise<LeadScope> {
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

/** A branch-scoped user may only place a lead in one of their branches. */
function branchInScope(scope: LeadScope, branchId: string | null | undefined): boolean {
  if (!scope.branchIds) return true; // shop-wide user
  if (!branchId) return false; // scoped user cannot create/keep an unbranched lead
  return scope.branchIds.includes(branchId);
}

function serializeLead(row: LeadRow) {
  return rowToApi(row);
}

/* ------------------------------------------------------------------ */
/* GET /api/crm/leads                                                  */
/* ------------------------------------------------------------------ */
router.get('/', ...requireCrmPermission('lead', 'view'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const parsed = parseListQuery(req.query as Record<string, unknown>, LEAD_LIST_CONFIG);

  try {
    const { rows, total } = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      return listLeads(client, { shopId: ctx.shopId, scope, parsed });
    });
    res.json({
      data: rowsToApi(rows),
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
    });
  } catch (err: any) {
    console.error('[GET /api/crm/leads] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/leads/:id                                              */
/* ------------------------------------------------------------------ */
router.get('/:id', ...requireCrmPermission('lead', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const lead = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      return getLeadById(client, ctx.shopId, req.params.id, { scope });
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(serializeLead(lead));
  } catch (err: any) {
    console.error('[GET /api/crm/leads/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/leads                                                 */
/* ------------------------------------------------------------------ */
router.post('/', ...requireCrmPermission('lead', 'create'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const data = pickWritable(req.body);
  const assignedToRaw = req.body?.assignedTo ?? req.body?.assigned_to;

  if (!data.name || String(data.name).trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (data.status && !LEAD_STATUSES.includes(data.status as any)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  if (data.status === 'converted') {
    return res.status(400).json({ error: 'A lead cannot be created as "converted" — use the convert endpoint' });
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);

      let branchId: string | null = data.branch_id ?? null;
      if (branchId) {
        if (!(await branchBelongsToShop(client, ctx.shopId, branchId))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
      }
      if (!branchInScope(scope, branchId)) {
        return { err: { status: 403, msg: 'You can only create leads within your assigned branch(es)' } };
      }

      // dealer persona: force ownership to self unless they also hold lead.assign
      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, ctx.shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }
      if (ctx.crmRole === 'dealer') assignedTo = ctx.user.id;

      const lead = await insertLead(client, {
        shopId: ctx.shopId,
        createdBy: ctx.user.id,
        data: { ...data, branch_id: branchId, assigned_to: assignedTo },
      });

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId,
        entityType: 'lead',
        entityId: lead.id,
        type: 'system',
        body: 'Lead created',
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId,
          actorUserId: ctx.user.id,
          entityType: 'lead',
          entityId: lead.id,
          action: 'create',
          after: lead,
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'lead.created',
          payload: { leadId: lead.id, assignedTo },
          dedupeKey: `lead.created:${lead.id}`,
        },
        client,
      );
      return { lead };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(serializeLead(outcome.lead));
  } catch (err: any) {
    console.error('[POST /api/crm/leads] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create lead' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH / PUT /api/crm/leads/:id                                      */
/* ------------------------------------------------------------------ */
async function handleUpdate(req: Request, res: Response) {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to; // assignment has its own endpoint/permission

  if ('name' in patch && (!patch.name || String(patch.name).trim().length === 0)) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if (patch.status && !LEAD_STATUSES.includes(patch.status as any)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  if (patch.status === 'converted') {
    return res.status(400).json({ error: 'Set status "converted" via the convert endpoint only' });
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const before = await getLeadById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };

      if ('branch_id' in patch && patch.branch_id) {
        if (!(await branchBelongsToShop(client, ctx.shopId, patch.branch_id))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        if (!branchInScope(scope, patch.branch_id)) {
          return { err: { status: 403, msg: 'That branch is outside your scope' } };
        }
      }

      const updated = await updateLead(client, ctx.shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Lead not found' } };

      const statusChanged = patch.status && patch.status !== before.status;
      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: updated.branch_id,
        entityType: 'lead',
        entityId: updated.id,
        type: statusChanged ? 'status_change' : 'note',
        body: statusChanged ? `Status: ${before.status} → ${patch.status}` : 'Lead updated',
        data: { changed: Object.keys(patch) },
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'lead',
          entityId: updated.id,
          action: 'update',
          before,
          after: updated,
        },
        client,
      );
      return { lead: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serializeLead(outcome.lead));
  } catch (err: any) {
    console.error('[PATCH /api/crm/leads/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update lead' });
  }
}
router.patch('/:id', ...requireCrmPermission('lead', 'update'), handleUpdate);
router.put('/:id', ...requireCrmPermission('lead', 'update'), handleUpdate);

/* ------------------------------------------------------------------ */
/* DELETE /api/crm/leads/:id   (soft delete)                           */
/* ------------------------------------------------------------------ */
router.delete('/:id', ...requireCrmPermission('lead', 'delete'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const before = await getLeadById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };

      const ok = await softDeleteLead(client, ctx.shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Lead not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: before.branch_id,
        entityType: 'lead',
        entityId: before.id,
        type: 'system',
        body: 'Lead deleted',
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: before.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'lead',
          entityId: before.id,
          action: 'delete',
          before,
        },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Lead deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/crm/leads/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/leads/:id/assign                                      */
/* ------------------------------------------------------------------ */
router.post('/:id/assign', ...requireCrmPermission('lead', 'assign'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  const branchIdRaw = req.body?.branchId ?? req.body?.branch_id;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const before = await getLeadById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };

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

      const updated = await updateLead(client, ctx.shopId, req.params.id, {
        assigned_to: String(assignedTo),
        branch_id: branchId,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Lead not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId,
        entityType: 'lead',
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
          entityType: 'lead',
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
          eventType: 'lead.assigned',
          payload: { leadId: updated.id, assignedTo: String(assignedTo), assignedBy: ctx.user.id },
          dedupeKey: `lead.assigned:${updated.id}:${assignedTo}`,
        },
        client,
      );
      return { lead: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serializeLead(outcome.lead));
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/leads/:id/qualify                                     */
/* ------------------------------------------------------------------ */
router.post('/:id/qualify', ...requireCrmPermission('lead', 'qualify'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const qualified = req.body?.qualified !== false && req.body?.status !== 'unqualified';
  const nextStatus = qualified ? 'qualified' : 'unqualified';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const before = await getLeadById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };
      if (before.status === 'converted') {
        return { err: { status: 409, msg: 'Lead is already converted' } };
      }

      const updated = await updateLead(client, ctx.shopId, req.params.id, {
        status: nextStatus,
        qualified_at: qualified ? new Date() : before.qualified_at,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Lead not found' } };

      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: updated.branch_id,
        entityType: 'lead',
        entityId: updated.id,
        type: 'qualification',
        body: `${before.status} → ${nextStatus}${reason ? ` (${reason})` : ''}`,
        data: { reason },
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'lead',
          entityId: updated.id,
          action: 'qualify',
          before: { status: before.status },
          after: { status: nextStatus },
          metadata: { reason },
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'lead.qualified',
          payload: { leadId: updated.id, status: nextStatus },
          dedupeKey: `lead.qualified:${updated.id}:${nextStatus}`,
        },
        client,
      );
      return { lead: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serializeLead(outcome.lead));
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/qualify] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to qualify lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/leads/:id/convert                                     */
/* ------------------------------------------------------------------ */
router.post('/:id/convert', ...requireCrmPermission('lead', 'convert'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      return convertLead(client, {
        shopId: ctx.shopId,
        actorUserId: ctx.user.id,
        leadId: req.params.id,
        scope,
      });
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({
      lead: rowToApi(outcome.result.lead),
      customer: rowToApi(outcome.result.customer),
      customerCreated: outcome.result.customerCreated,
      alreadyConverted: outcome.result.alreadyConverted,
    });
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/convert] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to convert lead' });
  }
});

/* ------------------------------------------------------------------ */
/* GET / POST /api/crm/leads/:id/activities                            */
/* ------------------------------------------------------------------ */
router.get('/:id/activities', ...requireCrmPermission('lead', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const payload = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const lead = await getLeadById(client, ctx.shopId, req.params.id, { scope });
      if (!lead) return null;
      const { rows, total } = await listActivity(client, ctx.shopId, 'lead', req.params.id, { limit, offset });
      return { rows, total };
    });
    if (!payload) return res.status(404).json({ error: 'Lead not found' });
    res.json({ data: rowsToApi(payload.rows), total: payload.total, limit, offset });
  } catch (err: any) {
    console.error('[GET /api/crm/leads/:id/activities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/:id/activities', ...requireCrmPermission('lead', 'update'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const allowedTypes: ActivityType[] = ['note', 'call', 'email', 'meeting'];
  const type: ActivityType = allowedTypes.includes(req.body?.type) ? req.body.type : 'note';
  if (!body) return res.status(400).json({ error: 'body is required' });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      const lead = await getLeadById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!lead) return { err: { status: 404, msg: 'Lead not found' } };

      const activity = await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: lead.branch_id,
        entityType: 'lead',
        entityId: lead.id,
        type,
        body,
        actorUserId: ctx.user.id,
      });
      await updateLead(client, ctx.shopId, lead.id, { last_activity_at: new Date() });
      return { activity };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.activity));
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/activities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to add activity' });
  }
});

export default router;
