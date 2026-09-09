/**
 * Shared "notify a user once" helper for CRM outbox handlers.
 *
 * Idempotency: the worker may retry a row (crash between handler success and
 * `markOutboxCompleted`). Each handler therefore checks for an existing
 * notification keyed by (entity_type, entity_id, type, user) before inserting.
 *
 * Tenant scope: the caller passes a client obtained from
 * `withTenant(row.shop_id, …)`, so `crm_notification`'s RLS policy is satisfied
 * and the work cannot touch another shop.
 */

import type { PoolClient } from 'pg';
import { createNotification } from '../../notifications/repository';

export async function notifyUserOnce(
  client: PoolClient,
  args: {
    shopId: string;
    userId: string | null;
    entityType: 'lead' | 'customer' | 'opportunity' | 'task';
    entityId: string;
    type: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!args.userId) return; // nothing to target yet (no assignee)
  const { rows } = await client.query(
    `SELECT 1 FROM crm_notification
      WHERE shop_id = $1 AND user_id = $2 AND entity_type = $3
        AND entity_id = $4 AND type = $5
      LIMIT 1`,
    [args.shopId, args.userId, args.entityType, args.entityId, args.type],
  );
  if (rows.length > 0) return; // already delivered

  await createNotification(
    {
      shopId: args.shopId,
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body ?? null,
      entityType: args.entityType,
      entityId: args.entityId,
      data: args.data ?? null,
    },
    client,
  );
}
