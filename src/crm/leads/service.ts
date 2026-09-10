/**
 * Lead conversion — the one CRM write path that also touches the ERP
 * `customers` table.
 *
 * Runs inside a single tenant transaction (`withTenant(ctx.shopId, …)`), so:
 *   - `crm_lead` / `crm_activity` / `crm_audit_log` / `crm_outbox` writes are
 *     RLS-checked against `app.shop_id`;
 *   - `customers` (not under RLS) is scoped with an explicit
 *     `WHERE shop_id = $1` using the verified shop id;
 *   - nothing here reads a shop id, customer id, or lead id from request input
 *     beyond the `:id` path param, which is itself matched against the shop.
 *
 * Dedupe strategy (documented): an existing customer is reused when
 *   1. the lead already points at one (`crm_lead.customer_id`), or
 *   2. a non-deleted customer in the same shop has the same `phone`.
 * Otherwise a new customer is created from the lead. A lead that is already
 * converted returns its existing customer (idempotent) instead of making a
 * duplicate.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import { recordAudit } from '../audit/recordAudit';
import { enqueueOutbox } from '../outbox/repository';
import { recordActivity } from '../activity/repository';
import {
  getLeadById,
  findCustomerByPhone,
  findExistingOpportunityForLead,
  updateLead,
  type LeadRow,
  type LeadScope,
  type QualificationStatus,
} from './repository';
import {
  insertOpportunity,
  getOpportunityById,
  OPEN_OPPORTUNITY_STAGES,
  type OpportunityStage,
} from '../opportunities/repository';

export interface ConvertResult {
  lead: LeadRow;
  customer: Record<string, any>;
  customerCreated: boolean;
  alreadyConverted: boolean;
}

async function loadCustomer(
  client: PoolClient,
  shopId: string,
  customerId: string,
): Promise<Record<string, any> | null> {
  const { rows } = await client.query(
    `SELECT * FROM customers WHERE shop_id = $1 AND id = $2`,
    [shopId, customerId],
  );
  return rows[0] ?? null;
}

export async function convertLead(
  client: PoolClient,
  args: {
    shopId: string;
    actorUserId: string | null;
    leadId: string;
    scope: LeadScope | null;
  },
): Promise<{ ok: true; result: ConvertResult } | { ok: false; status: number; error: string }> {
  const { shopId, actorUserId, leadId, scope } = args;

  const lead = await getLeadById(client, shopId, leadId, { scope, forUpdate: true });
  if (!lead) return { ok: false, status: 404, error: 'Lead not found' };

  // Idempotent: already converted -> return the linked customer, no new row.
  if (lead.converted_customer_id) {
    const existing = await loadCustomer(client, shopId, lead.converted_customer_id);
    if (existing) {
      return {
        ok: true,
        result: { lead, customer: existing, customerCreated: false, alreadyConverted: true },
      };
    }
  }

  // 1. dedupe
  let customerId: string | null = lead.customer_id ?? null;
  let customerCreated = false;

  if (!customerId && lead.phone) {
    const dup = await findCustomerByPhone(client, shopId, lead.phone);
    if (dup) customerId = dup.id;
  }

  // 2. create if still none
  if (!customerId) {
    customerId = generateId('cust');
    await client.query(
      `INSERT INTO customers
         (id, shop_id, name, phone, email, address, source, status,
          assigned_to, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
      [
        customerId,
        shopId,
        lead.name,
        lead.phone ?? null,
        lead.email ?? null,
        '', // customers.address is NOT NULL in the existing schema
        lead.source ?? null,
        lead.assigned_to ?? null,
        lead.branch_id ?? null,
      ],
    );
    customerCreated = true;
  }

  // 3. mark the lead converted
  const updated = await updateLead(client, shopId, leadId, {
    status: 'converted',
    converted_customer_id: customerId,
    converted_at: new Date(),
    last_activity_at: new Date(),
  });
  const finalLead = updated ?? lead;

  // 4. timeline entries (both sides)
  await recordActivity(client, {
    shopId,
    branchId: lead.branch_id,
    entityType: 'lead',
    entityId: leadId,
    type: 'conversion',
    body: customerCreated ? 'Lead converted — new customer created' : 'Lead converted — linked to existing customer',
    data: { customerId, customerCreated },
    actorUserId,
  });
  await recordActivity(client, {
    shopId,
    branchId: lead.branch_id,
    entityType: 'customer',
    entityId: customerId,
    type: 'conversion',
    body: 'Created from lead conversion',
    data: { leadId },
    actorUserId,
  });

  // 5. audit
  await recordAudit(
    {
      shopId,
      branchId: lead.branch_id,
      actorUserId,
      entityType: 'lead',
      entityId: leadId,
      action: 'convert',
      before: { status: lead.status, converted_customer_id: lead.converted_customer_id },
      after: { status: 'converted', converted_customer_id: customerId },
      metadata: { customerCreated },
    },
    client,
  );

  // 6. outbox (idempotent per lead)
  await enqueueOutbox(
    {
      shopId,
      eventType: 'lead.converted',
      payload: { leadId, customerId, customerCreated },
      dedupeKey: `lead.converted:${leadId}`,
    },
    client,
  );

  const customer = await loadCustomer(client, shopId, customerId);
  return {
    ok: true,
    result: {
      lead: finalLead,
      customer: customer ?? { id: customerId },
      customerCreated,
      alreadyConverted: false,
    },
  };
}

/* ================================================================== */
/* Phase 3 — structured qualification                                  */
/* ================================================================== */

/**
 * Structured qualification input. `outcome` is the one required field; the
 * route has already validated the shape (enum, score range, reason presence
 * for `disqualified`, `data` key whitelist, `nurtureUntil` date parse).
 */
export interface QualifyInput {
  outcome: QualificationStatus;
  score?: number | null;
  notes?: string | null;
  reason?: string | null;
  data?: Record<string, unknown> | null;
  nurtureUntil?: string | null;
}

export interface QualifyResult {
  lead: LeadRow;
  outcome: QualificationStatus;
}

/**
 * Record a qualification outcome on a lead. Runs inside the caller's tenant
 * transaction. Mirrors `convertLead`: tenant + scope are enforced by
 * `getLeadById`, and every side effect (activity / audit / outbox) is written
 * in the same transaction.
 *
 * Outcome -> effect (see approved Phase 3 design §10):
 *   qualified     -> qualification_status='qualified', status='qualified',
 *                    qualified_at/qualified_by stamped, disqualified_* cleared
 *   disqualified  -> qualification_status='disqualified', status='unqualified',
 *                    disqualified_at stamped, disqualified_reason stored
 *   nurture       -> qualification_status='nurture'; `status` left untouched
 *                    (the status enum has no 'nurture' value on purpose)
 */
export async function qualifyLead(
  client: PoolClient,
  args: {
    shopId: string;
    actorUserId: string | null;
    leadId: string;
    scope: LeadScope | null;
    input: QualifyInput;
  },
): Promise<{ ok: true; result: QualifyResult } | { ok: false; status: number; error: string }> {
  const { shopId, actorUserId, leadId, scope, input } = args;
  const outcome = input.outcome;
  const now = new Date();

  const lead = await getLeadById(client, shopId, leadId, { scope, forUpdate: true });
  if (!lead) return { ok: false, status: 404, error: 'Lead not found' };
  if (lead.status === 'converted') {
    return { ok: false, status: 409, error: 'Lead is already converted' };
  }

  const patch: Parameters<typeof updateLead>[3] = {
    qualification_status: outcome,
    last_activity_at: now,
  };
  if (input.score !== undefined) patch.qualification_score = input.score;
  if (input.notes !== undefined) patch.qualification_notes = input.notes;
  if (input.data !== undefined) patch.qualification_data = input.data;

  if (outcome === 'qualified') {
    patch.status = 'qualified';
    patch.qualified_at = now;
    patch.qualified_by = actorUserId;
    patch.disqualified_at = null;
    patch.disqualified_reason = null;
  } else if (outcome === 'disqualified') {
    patch.status = 'unqualified';
    patch.disqualified_at = now;
    patch.disqualified_reason = input.reason ?? null;
  } else {
    // nurture — leave `status` exactly as it was.
    if (input.nurtureUntil !== undefined) patch.nurture_until = input.nurtureUntil;
  }

  const updated = await updateLead(client, shopId, leadId, patch);
  const finalLead = updated ?? lead;

  await recordActivity(client, {
    shopId,
    branchId: lead.branch_id,
    entityType: 'lead',
    entityId: leadId,
    type: 'qualification',
    body: `${lead.qualification_status ?? lead.status} → ${outcome}${input.reason ? ` (${input.reason})` : ''}`,
    data: {
      outcome,
      from: lead.qualification_status,
      previousStatus: lead.status,
      score: input.score ?? null,
      reason: input.reason ?? null,
    },
    actorUserId,
  });

  await recordAudit(
    {
      shopId,
      branchId: lead.branch_id,
      actorUserId,
      entityType: 'lead',
      entityId: leadId,
      action: 'qualify',
      before: { status: lead.status, qualification_status: lead.qualification_status },
      after: { status: finalLead.status, qualification_status: outcome },
      metadata: { outcome, score: input.score ?? null, reason: input.reason ?? null },
    },
    client,
  );

  await enqueueOutbox(
    {
      shopId,
      eventType: 'lead.qualified',
      payload: { leadId, outcome, qualificationStatus: outcome },
      dedupeKey: `lead.qualified:${leadId}:${outcome}`,
    },
    client,
  );

  return { ok: true, result: { lead: finalLead, outcome } };
}

/* ================================================================== */
/* Phase 3 — lead -> opportunity promotion                             */
/* ================================================================== */

export interface PromoteInput {
  title?: string | null;
  stage?: string | null;
  amount?: number | null;
  probability?: number | null;
  expectedCloseDate?: string | null;
  notes?: string | null;
}

export interface PromoteResult {
  lead: LeadRow;
  opportunity: Record<string, any>;
  alreadyPromoted: boolean;
}

/**
 * Promote a qualified lead into the EXISTING `crm_opportunity` pipeline.
 *
 * Idempotent (approved design §11.3): if a non-deleted opportunity is already
 * linked to the lead, it is returned with `alreadyPromoted: true` and NOTHING
 * else is written — no second opportunity, no activity / audit / outbox.
 *
 * Otherwise the lead must be qualified (`qualification_status = 'qualified'`
 * or the legacy `status = 'qualified'`). The new opportunity inherits the
 * lead's branch, assignee, source and customer link — none of those come from
 * request input.
 */
export async function promoteLeadToOpportunity(
  client: PoolClient,
  args: {
    shopId: string;
    actorUserId: string | null;
    leadId: string;
    scope: LeadScope | null;
    input: PromoteInput;
  },
): Promise<{ ok: true; result: PromoteResult } | { ok: false; status: number; error: string }> {
  const { shopId, actorUserId, leadId, scope, input } = args;
  const now = new Date();

  const lead = await getLeadById(client, shopId, leadId, { scope, forUpdate: true });
  if (!lead) return { ok: false, status: 404, error: 'Lead not found' };

  // Idempotent: an opportunity already exists for this lead -> return it.
  const existing = await findExistingOpportunityForLead(client, shopId, leadId);
  if (existing) {
    const opp = await getOpportunityById(client, shopId, existing.id);
    return {
      ok: true,
      result: { lead, opportunity: opp ?? { id: existing.id }, alreadyPromoted: true },
    };
  }

  const isQualified =
    lead.qualification_status === 'qualified' || lead.status === 'qualified';
  if (!isQualified) {
    return {
      ok: false,
      status: 409,
      error: 'Lead must be qualified before it can be promoted to an opportunity',
    };
  }

  const stage: OpportunityStage = OPEN_OPPORTUNITY_STAGES.includes(
    (input.stage ?? '') as (typeof OPEN_OPPORTUNITY_STAGES)[number],
  )
    ? (input.stage as OpportunityStage)
    : 'qualification';
  const title =
    (input.title && String(input.title).trim()) || lead.company || lead.name;

  const opp = await insertOpportunity(client, {
    shopId,
    createdBy: actorUserId,
    data: {
      title,
      stage,
      amount: input.amount ?? null,
      probability: input.probability ?? null,
      source: lead.source ?? null,
      notes: input.notes ?? null,
      expected_close_date: input.expectedCloseDate ?? null,
      branch_id: lead.branch_id ?? null,
      assigned_to: lead.assigned_to ?? null,
      lead_id: lead.id,
      customer_id: lead.converted_customer_id ?? lead.customer_id ?? null,
    },
  });

  const updated = await updateLead(client, shopId, leadId, { last_activity_at: now });
  const finalLead = updated ?? lead;

  await recordActivity(client, {
    shopId,
    branchId: lead.branch_id,
    entityType: 'lead',
    entityId: leadId,
    type: 'promotion',
    body: 'Promoted to opportunity',
    data: { opportunityId: opp.id },
    actorUserId,
  });
  await recordActivity(client, {
    shopId,
    branchId: opp.branch_id,
    entityType: 'opportunity',
    entityId: opp.id,
    type: 'system',
    body: 'Created from lead promotion',
    data: { leadId },
    actorUserId,
  });

  await recordAudit(
    {
      shopId,
      branchId: lead.branch_id,
      actorUserId,
      entityType: 'lead',
      entityId: leadId,
      action: 'promote',
      before: { status: lead.status, qualification_status: lead.qualification_status },
      after: { opportunityId: opp.id },
    },
    client,
  );
  await recordAudit(
    {
      shopId,
      branchId: opp.branch_id,
      actorUserId,
      entityType: 'opportunity',
      entityId: opp.id,
      action: 'create',
      after: opp,
      metadata: { promotedFromLeadId: leadId },
    },
    client,
  );

  await enqueueOutbox(
    {
      shopId,
      eventType: 'lead.promoted',
      payload: { leadId, opportunityId: opp.id },
      dedupeKey: `lead.promoted:${leadId}`,
    },
    client,
  );

  return {
    ok: true,
    result: { lead: finalLead, opportunity: opp, alreadyPromoted: false },
  };
}
