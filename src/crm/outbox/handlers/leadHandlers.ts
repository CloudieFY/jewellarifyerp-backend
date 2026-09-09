/**
 * First CRM outbox handlers (Phase 1).
 *
 * These are deliberately minimal and side-effect-light: they write an in-app
 * `crm_notification` row and nothing else. No WhatsApp / Meta / email — those
 * arrive in a later phase behind a real integration interface.
 *
 * Idempotency: the worker can retry a row (crash between handler success and
 * `markOutboxCompleted`). `notifyUserOnce()` checks for an existing
 * notification keyed by (entity, type, user) before inserting.
 *
 * Tenant scope: every handler runs inside `withTenant(row.shop_id, …)` so the
 * `crm_notification` RLS policy is satisfied and the work cannot touch another
 * shop.
 */

import { withTenant } from '../../../utils/db';
import { registerOutboxHandler, type OutboxHandler } from '../worker';
import type { OutboxRow } from '../repository';
import { notifyUserOnce } from './_notify';

const onLeadCreated: OutboxHandler = async (row: OutboxRow) => {
  const { leadId, assignedTo } = row.payload as { leadId?: string; assignedTo?: string | null };
  if (!leadId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'lead',
      entityId: leadId,
      type: 'lead.created',
      title: 'New lead assigned to you',
    }),
  );
};

const onLeadAssigned: OutboxHandler = async (row: OutboxRow) => {
  const { leadId, assignedTo } = row.payload as { leadId?: string; assignedTo?: string | null };
  if (!leadId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'lead',
      entityId: leadId,
      type: 'lead.assigned',
      title: 'A lead was assigned to you',
    }),
  );
};

const onLeadQualified: OutboxHandler = async (row: OutboxRow) => {
  const { leadId, status } = row.payload as { leadId?: string; status?: string };
  if (!leadId) return;
  await withTenant(row.shop_id, async (client) => {
    const { rows } = await client.query(
      `SELECT assigned_to FROM crm_lead WHERE shop_id = $1 AND id = $2`,
      [row.shop_id, leadId],
    );
    const assignedTo = rows[0]?.assigned_to ?? null;
    await notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'lead',
      entityId: leadId,
      type: 'lead.qualified',
      title: `Lead ${status ?? 'qualified'}`,
      data: { status },
    });
  });
};

const onLeadConverted: OutboxHandler = async (row: OutboxRow) => {
  const { leadId, customerId } = row.payload as { leadId?: string; customerId?: string };
  if (!leadId) return;
  await withTenant(row.shop_id, async (client) => {
    const { rows } = await client.query(
      `SELECT assigned_to FROM crm_lead WHERE shop_id = $1 AND id = $2`,
      [row.shop_id, leadId],
    );
    const assignedTo = rows[0]?.assigned_to ?? null;
    await notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'lead',
      entityId: leadId,
      type: 'lead.converted',
      title: 'Lead converted to customer',
      data: { customerId },
    });
  });
};

/** Register the Phase 1 lead handlers. Safe to call more than once. */
export function registerLeadOutboxHandlers(): void {
  registerOutboxHandler('lead.created', onLeadCreated);
  registerOutboxHandler('lead.assigned', onLeadAssigned);
  registerOutboxHandler('lead.qualified', onLeadQualified);
  registerOutboxHandler('lead.converted', onLeadConverted);
}
