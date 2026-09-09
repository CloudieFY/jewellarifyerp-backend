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
  updateLead,
  type LeadRow,
  type LeadScope,
} from './repository';

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
