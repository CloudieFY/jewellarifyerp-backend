import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowToApi, rowsToApi } from '../../db/mapping';
import { requireCrmPermission } from '../middleware/requireCrmPermission';
import { parseListQuery, assertNoClientShopScope, type ListQueryConfig } from '../db/listQuery';
import { recordAudit } from '../audit/recordAudit';
import { enqueueOutbox } from '../outbox/repository';
import { recordActivity, listActivity, type ActivityType } from '../activity/repository';
import {
  convertLead,
  qualifyLead,
  promoteLeadToOpportunity,
  type QualifyInput,
  type PromoteInput,
} from '../leads/service';
import {
  listLeads,
  getLeadById,
  insertLead,
  updateLead,
  softDeleteLead,
  branchBelongsToShop,
  userBelongsToShop,
  LEAD_STATUSES,
  QUALIFICATION_STATUSES,
  type LeadScope,
  type LeadRow,
  type LeadWritable,
  type QualificationStatus,
} from '../leads/repository';
import { OPEN_OPPORTUNITY_STAGES } from '../opportunities/repository';
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
  // customer_id / converted_customer_id let the Customer 360 view pull the
  // leads tied to one customer; both are real crm_lead columns and are matched
  // as bound equality params by parseListQuery (no SQL identifier interpolation).
  filterable: [
    'status',
    'source',
    'assigned_to',
    'branch_id',
    'customer_id',
    'converted_customer_id',
    'qualification_status',
  ],
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
/* POST /api/crm/leads/:id/qualify   (Phase 3 — structured)            */
/* ------------------------------------------------------------------ */

/** Whitelisted `qualification_data` keys and the enum values we accept. */
const QUALIFICATION_DATA_ENUMS: Record<string, readonly string[]> = {
  authority: ['decision_maker', 'influencer', 'none', 'unknown'],
  need: ['high', 'medium', 'low', 'unknown'],
  timeline: ['immediate', '1_3_months', '3_6_months', '6_plus_months', 'unknown'],
};
const QUALIFICATION_DATA_TEXT_MAX: Record<string, number> = {
  budget: 120,
  interest: 200,
  objections: 500,
};
const QUALIFICATION_DATA_KEYS = new Set([
  ...Object.keys(QUALIFICATION_DATA_ENUMS),
  ...Object.keys(QUALIFICATION_DATA_TEXT_MAX),
]);

function parseQualificationData(
  raw: unknown,
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'data must be an object' };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    if (!QUALIFICATION_DATA_KEYS.has(k)) {
      return { ok: false, error: `data.${k} is not an accepted qualification field` };
    }
    if (k in QUALIFICATION_DATA_ENUMS) {
      if (typeof v !== 'string' || !QUALIFICATION_DATA_ENUMS[k].includes(v)) {
        return { ok: false, error: `data.${k} must be one of: ${QUALIFICATION_DATA_ENUMS[k].join(', ')}` };
      }
      out[k] = v;
    } else {
      const max = QUALIFICATION_DATA_TEXT_MAX[k];
      if (typeof v !== 'string' || v.length > max) {
        return { ok: false, error: `data.${k} must be a string of at most ${max} characters` };
      }
      out[k] = v;
    }
  }
  if (Object.keys(out).length === 0) return { ok: true, value: null };
  if (JSON.stringify(out).length > 4096) {
    return { ok: false, error: 'data is too large' };
  }
  return { ok: true, value: out };
}

function parseQualifyBody(
  body: any,
): { ok: true; value: QualifyInput } | { ok: false; error: string } {
  const b = body ?? {};

  // Outcome: prefer the explicit Phase 3 field; fall back to the Phase 1 shape
  // ({ qualified: boolean, status: 'unqualified' }) so old clients keep working.
  let outcome: QualificationStatus;
  const explicitOutcome = b.outcome !== undefined;
  if (explicitOutcome) {
    if (!QUALIFICATION_STATUSES.includes(b.outcome)) {
      return { ok: false, error: `outcome must be one of: ${QUALIFICATION_STATUSES.join(', ')}` };
    }
    outcome = b.outcome;
  } else {
    const legacyDisqualified = b.qualified === false || b.status === 'unqualified';
    outcome = legacyDisqualified ? 'disqualified' : 'qualified';
  }

  let score: number | null | undefined;
  if (b.score !== undefined && b.score !== null && b.score !== '') {
    const n = Number(b.score);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, error: 'score must be an integer between 0 and 100' };
    }
    score = n;
  } else if (b.score === null || b.score === '') {
    score = null;
  }

  const reason =
    typeof b.reason === 'string' && b.reason.trim().length > 0 ? b.reason.trim() : null;
  // The stricter "reason required to disqualify" rule applies to the explicit
  // Phase 3 `outcome` shape; the legacy { qualified: false } shape stays lenient.
  if (explicitOutcome && outcome === 'disqualified' && !reason) {
    return { ok: false, error: 'reason is required when disqualifying a lead' };
  }

  const notes =
    typeof b.notes === 'string' && b.notes.trim().length > 0 ? b.notes.trim() : undefined;

  const dataParsed = parseQualificationData(b.data);
  if (!dataParsed.ok) return { ok: false, error: dataParsed.error };

  let nurtureUntil: string | null | undefined;
  const rawNurture = b.nurtureUntil ?? b.nurture_until;
  if (rawNurture !== undefined && rawNurture !== null && rawNurture !== '') {
    const s = String(rawNurture);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
      return { ok: false, error: 'nurtureUntil must be a YYYY-MM-DD date' };
    }
    nurtureUntil = s;
  } else if (rawNurture === null || rawNurture === '') {
    nurtureUntil = null;
  }

  const value: QualifyInput = { outcome, reason };
  if (score !== undefined) value.score = score;
  if (notes !== undefined) value.notes = notes;
  if (b.data !== undefined) value.data = dataParsed.value;
  if (nurtureUntil !== undefined) value.nurtureUntil = nurtureUntil;
  return { ok: true, value };
}

router.post('/:id/qualify', ...requireCrmPermission('lead', 'qualify'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;

  const parsed = parseQualifyBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      return qualifyLead(client, {
        shopId: ctx.shopId,
        actorUserId: ctx.user.id,
        leadId: req.params.id,
        scope,
        input: parsed.value,
      });
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(serializeLead(outcome.result.lead));
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/qualify] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to qualify lead' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/leads/:id/promote   (Phase 3 — lead -> opportunity)   */
/* ------------------------------------------------------------------ */
router.post('/:id/promote', ...requireCrmPermission('opportunity', 'create'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const b = req.body ?? {};

  const input: PromoteInput = {};
  if (typeof b.title === 'string' && b.title.trim().length > 0) input.title = b.title.trim();
  if (b.notes !== undefined) input.notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;

  if (b.stage !== undefined && b.stage !== null && b.stage !== '') {
    if (!OPEN_OPPORTUNITY_STAGES.includes(b.stage)) {
      return res.status(400).json({ error: `stage must be one of: ${OPEN_OPPORTUNITY_STAGES.join(', ')}` });
    }
    input.stage = b.stage;
  }
  if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
    const n = Number(b.amount);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
    input.amount = n;
  }
  if (b.probability !== undefined && b.probability !== null && b.probability !== '') {
    const n = Number(b.probability);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: 'probability must be an integer between 0 and 100' });
    }
    input.probability = n;
  }
  const rawClose = b.expectedCloseDate ?? b.expected_close_date;
  if (rawClose !== undefined && rawClose !== null && rawClose !== '') {
    const s = String(rawClose);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
      return res.status(400).json({ error: 'expectedCloseDate must be a YYYY-MM-DD date' });
    }
    input.expectedCloseDate = s;
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveLeadScope(client, ctx);
      return promoteLeadToOpportunity(client, {
        shopId: ctx.shopId,
        actorUserId: ctx.user.id,
        leadId: req.params.id,
        scope,
        input,
      });
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.status(outcome.result.alreadyPromoted ? 200 : 201).json({
      lead: rowToApi(outcome.result.lead),
      opportunity: rowToApi(outcome.result.opportunity),
      alreadyPromoted: outcome.result.alreadyPromoted,
    });
  } catch (err: any) {
    console.error('[POST /api/crm/leads/:id/promote] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to promote lead' });
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
