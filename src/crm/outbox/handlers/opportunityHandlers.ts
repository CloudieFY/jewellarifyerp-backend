/**
 * CRM opportunity outbox handlers (Phase 2).
 *
 * Minimal and side-effect-light: they write an in-app `crm_notification` row
 * and nothing else (no WhatsApp / email — a later phase). Every handler runs
 * inside `withTenant(row.shop_id, …)`.
 */

import { withTenant } from '../../../utils/db';
import { registerOutboxHandler, type OutboxHandler } from '../worker';
import type { OutboxRow } from '../repository';
import { notifyUserOnce } from './_notify';

async function assigneeOf(client: any, shopId: string, oppId: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT assigned_to FROM crm_opportunity WHERE shop_id = $1 AND id = $2`,
    [shopId, oppId],
  );
  return rows[0]?.assigned_to ?? null;
}

const onOpportunityCreated: OutboxHandler = async (row: OutboxRow) => {
  const { opportunityId, assignedTo } = row.payload as { opportunityId: string; assignedTo?: string | null };
  if (!opportunityId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'opportunity',
      entityId: opportunityId,
      type: 'opportunity.created',
      title: 'New opportunity assigned to you',
    }),
  );
};

const onOpportunityAssigned: OutboxHandler = async (row: OutboxRow) => {
  const { opportunityId, assignedTo } = row.payload as { opportunityId: string; assignedTo?: string | null };
  if (!opportunityId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'opportunity',
      entityId: opportunityId,
      type: 'opportunity.assigned',
      title: 'An opportunity was assigned to you',
    }),
  );
};

const onOpportunityStageChanged: OutboxHandler = async (row: OutboxRow) => {
  const { opportunityId, stage } = row.payload as { opportunityId: string; stage?: string };
  if (!opportunityId) return;
  await withTenant(row.shop_id, async (client) => {
    const assignedTo = await assigneeOf(client, row.shop_id, opportunityId);
    await notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'opportunity',
      entityId: opportunityId,
      type: 'opportunity.stage_changed',
      title: `Opportunity moved to ${stage ?? 'a new stage'}`,
      data: { stage },
    });
  });
};

const onOpportunityWon: OutboxHandler = async (row: OutboxRow) => {
  const { opportunityId } = row.payload as { opportunityId: string };
  if (!opportunityId) return;
  await withTenant(row.shop_id, async (client) => {
    const assignedTo = await assigneeOf(client, row.shop_id, opportunityId);
    await notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'opportunity',
      entityId: opportunityId,
      type: 'opportunity.won',
      title: 'Opportunity won 🎉',
    });
  });
};

const onOpportunityLost: OutboxHandler = async (row: OutboxRow) => {
  const { opportunityId } = row.payload as { opportunityId: string };
  if (!opportunityId) return;
  await withTenant(row.shop_id, async (client) => {
    const assignedTo = await assigneeOf(client, row.shop_id, opportunityId);
    await notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'opportunity',
      entityId: opportunityId,
      type: 'opportunity.lost',
      title: 'Opportunity marked lost',
    });
  });
};

/** Register the Phase 2 opportunity handlers. Safe to call more than once. */
export function registerOpportunityOutboxHandlers(): void {
  registerOutboxHandler('opportunity.created', onOpportunityCreated);
  registerOutboxHandler('opportunity.assigned', onOpportunityAssigned);
  registerOutboxHandler('opportunity.stage_changed', onOpportunityStageChanged);
  registerOutboxHandler('opportunity.won', onOpportunityWon);
  registerOutboxHandler('opportunity.lost', onOpportunityLost);
}
