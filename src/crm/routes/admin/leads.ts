import { Router, Request, Response } from 'express';
import { withTenant, withSuperAdminCrmTx } from '../../../utils/db';
import { rowToApi, rowsToApi } from '../../../db/mapping';
import { parseListQuery, type ListQueryConfig } from '../../db/listQuery';
import { recordAudit } from '../../audit/recordAudit';
import { enqueueOutbox } from '../../outbox/repository';
import { recordActivity } from '../../activity/repository';
import { convertLead, qualifyLead, promoteLeadToOpportunity, type QualifyInput, type PromoteInput } from '../../leads/service';
import {
  getLeadById,
  insertLead,
  updateLead,
  softDeleteLead,
  branchBelongsToShop,
  userBelongsToShop,
  LEAD_STATUSES,
  QUALIFICATION_STATUSES,
  type LeadWritable,
} from '../../leads/repository';
import { OPEN_OPPORTUNITY_STAGES } from '../../opportunities/repository';
import { adminActorMeta } from './_shared';

/**
 * Super Admin CRM Lead API — mounted at /api/superadmin/crm/leads.
 *
 * Cross-shop `GET /` uses withSuperAdminCrmTx (migration 014's additive
 * SELECT-only RLS policy). Every other route operates on ONE shop taken from
 * the `:shopId` URL param, via withTenant(shopId, cb) — the exact same
 * tenant-isolation boundary and the exact same repository/service functions
 * (src/crm/leads/{repository,service}.ts) the tenant routes call. Super
 * Admin has no branch/dealer scope restriction (scope = null, shop-wide).
 */

const router = Router();

const LEAD_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'name', 'status', 'last_activity_at'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['status', 'source', 'assigned_to', 'branch_id', 'shop_id', 'qualification_status'],
  searchable: ['name', 'phone', 'email', 'company'],
  maxLimit: 100,
  defaultLimit: 25,
};

const WRITABLE_KEYS: Array<keyof LeadWritable> = ['name', 'phone', 'email', 'company', 'source', 'status', 'notes', 'branch_id'];

function pickWritable(body: any): Partial<LeadWritable> {
  const out: Partial<LeadWritable> = {};
  const map: Record<string, keyof LeadWritable> = {
    name: 'name', phone: 'phone', email: 'email', company: 'company', source: 'source',
    status: 'status', notes: 'notes', branchId: 'branch_id', branch_id: 'branch_id',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (col && WRITABLE_KEYS.includes(col)) (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* GET /  — cross-shop list                                            */
/* ------------------------------------------------------------------ */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseListQuery(req.query as Record<string, unknown>, LEAD_LIST_CONFIG);
  try {
    const { rows, total } = await withSuperAdminCrmTx(async (client) => {
      const baseConditions = ['deleted_at IS NULL'];
      const baseParams: unknown[] = [];
      // Bare column names here refer only to crm_lead — resolved inside a
      // subquery before shops is joined, so there is no ambiguity with
      // shops' own same-named columns (e.g. shops.status).
      const { text: whereSql, params } = parsed.buildWhere({ baseConditions, baseParams });

      const countRes = await client.query(`SELECT count(*)::int AS total FROM crm_lead ${whereSql}`, params);
      const dataRes = await client.query(
        `SELECT sub.*, s.shop_name
           FROM (
             SELECT * FROM crm_lead
             ${whereSql}
             ORDER BY ${parsed.orderBy.column} ${parsed.orderBy.direction}
             LIMIT ${parsed.limit} OFFSET ${parsed.offset}
           ) sub
           JOIN shops s ON s.id = sub.shop_id`,
        params,
      );
      return { rows: dataRes.rows, total: countRes.rows[0].total as number };
    });
    res.json({
      data: rowsToApi(rows),
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
    });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/leads] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:shopId/:id                                                     */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id', async (req: Request, res: Response) => {
  try {
    const lead = await withTenant(req.params.shopId, (client) => getLeadById(client, req.params.shopId, req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(rowToApi(lead));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/leads/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId  — create                                             */
/* ------------------------------------------------------------------ */
router.post('/:shopId', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
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

      const lead = await insertLead(client, {
        shopId,
        createdBy: null,
        data: { ...data, branch_id: branchId, assigned_to: assignedTo },
      });

      await recordActivity(client, {
        shopId, branchId, entityType: 'lead', entityId: lead.id, type: 'system',
        body: 'Lead created by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'lead', entityId: lead.id, action: 'create', after: lead, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'lead.created', payload: { leadId: lead.id, assignedTo }, dedupeKey: `lead.created:${lead.id}` },
        client,
      );
      return { lead };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.lead));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/leads/:shopId] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create lead' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:shopId/:id                                                   */
/* ------------------------------------------------------------------ */
router.patch('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to;

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
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getLeadById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };
      if ('branch_id' in patch && patch.branch_id && !(await branchBelongsToShop(client, shopId, patch.branch_id))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }

      const updated = await updateLead(client, shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Lead not found' } };

      const statusChanged = patch.status && patch.status !== before.status;
      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'lead', entityId: updated.id,
        type: statusChanged ? 'status_change' : 'note',
        body: statusChanged ? `Status: ${before.status} → ${patch.status} (Super Admin)` : 'Lead updated by Super Admin',
        data: { changed: Object.keys(patch), ...adminActorMeta(req) },
        actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'lead', entityId: updated.id, action: 'update', before, after: updated, metadata: adminActorMeta(req) },
        client,
      );
      return { lead: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.lead));
  } catch (err: any) {
    console.error('[PATCH /api/superadmin/crm/leads/:shopId/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update lead' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /:shopId/:id  (soft delete)                                  */
/* ------------------------------------------------------------------ */
router.delete('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getLeadById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };
      const ok = await softDeleteLead(client, shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Lead not found' } };

      await recordActivity(client, {
        shopId, branchId: before.branch_id, entityType: 'lead', entityId: before.id, type: 'system',
        body: 'Lead deleted by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: before.branch_id, actorUserId: null, entityType: 'lead', entityId: before.id, action: 'delete', before, metadata: adminActorMeta(req) },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Lead deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/superadmin/crm/leads/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete lead' });
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
      const before = await getLeadById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Lead not found' } };
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

      const updated = await updateLead(client, shopId, req.params.id, {
        assigned_to: String(assignedTo), branch_id: branchId, last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Lead not found' } };

      await recordActivity(client, {
        shopId, branchId, entityType: 'lead', entityId: updated.id, type: 'assignment',
        body: `Assigned to ${assignedTo} (by Super Admin)`,
        data: { from: before.assigned_to, to: String(assignedTo), ...adminActorMeta(req) },
        actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'lead', entityId: updated.id, action: 'assign', before: { assigned_to: before.assigned_to }, after: { assigned_to: updated.assigned_to }, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'lead.assigned', payload: { leadId: updated.id, assignedTo: String(assignedTo) }, dedupeKey: `lead.assigned:${updated.id}:${assignedTo}` },
        client,
      );
      return { lead: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.lead));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/leads/:shopId/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/qualify  — reuses src/crm/leads/service.ts        */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/qualify', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const b = req.body ?? {};
  if (!QUALIFICATION_STATUSES.includes(b.outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${QUALIFICATION_STATUSES.join(', ')}` });
  }
  const input: QualifyInput = {
    outcome: b.outcome,
    reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : null,
    ...(b.score !== undefined ? { score: Number(b.score) } : {}),
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
  };
  if (input.outcome === 'disqualified' && !input.reason) {
    return res.status(400).json({ error: 'reason is required when disqualifying a lead' });
  }

  try {
    const outcome = await withTenant(shopId, (client) =>
      qualifyLead(client, { shopId, actorUserId: null, leadId: req.params.id, scope: null, input }),
    );
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(rowToApi(outcome.result.lead));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/leads/:shopId/:id/qualify] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to qualify lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/promote  — lead -> opportunity                    */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/promote', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const b = req.body ?? {};
  const input: PromoteInput = {};
  if (typeof b.title === 'string' && b.title.trim()) input.title = b.title.trim();
  if (b.stage !== undefined && b.stage !== null && b.stage !== '') {
    if (!OPEN_OPPORTUNITY_STAGES.includes(b.stage)) {
      return res.status(400).json({ error: `stage must be one of: ${OPEN_OPPORTUNITY_STAGES.join(', ')}` });
    }
    input.stage = b.stage;
  }
  if (b.amount !== undefined && b.amount !== null && b.amount !== '') input.amount = Number(b.amount);
  if (b.probability !== undefined && b.probability !== null && b.probability !== '') input.probability = Number(b.probability);

  try {
    const outcome = await withTenant(shopId, (client) =>
      promoteLeadToOpportunity(client, { shopId, actorUserId: null, leadId: req.params.id, scope: null, input }),
    );
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.status(outcome.result.alreadyPromoted ? 200 : 201).json({
      lead: rowToApi(outcome.result.lead),
      opportunity: rowToApi(outcome.result.opportunity),
      alreadyPromoted: outcome.result.alreadyPromoted,
    });
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/leads/:shopId/:id/promote] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to promote lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/convert                                           */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/convert', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  try {
    const outcome = await withTenant(shopId, (client) =>
      convertLead(client, { shopId, actorUserId: null, leadId: req.params.id, scope: null }),
    );
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({
      lead: rowToApi(outcome.result.lead),
      customer: rowToApi(outcome.result.customer),
      customerCreated: outcome.result.customerCreated,
      alreadyConverted: outcome.result.alreadyConverted,
    });
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/leads/:shopId/:id/convert] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to convert lead' });
  }
});

export default router;
