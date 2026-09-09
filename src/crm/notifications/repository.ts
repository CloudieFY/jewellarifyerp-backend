/**
 * CRM in-app notification store — data access.
 *
 * Tenant-scoped: every function takes a verified `shopId` (from
 * req.pgTenant.shopId) and every query is filtered by it. `crm_notification`
 * is under FORCE RLS (migration 009) so writes from CRM request / worker
 * paths must run on a client obtained from `withTenant(shopId, …)`.
 */

import type { Pool, PoolClient } from 'pg';
import { pgPool } from '../../config/postgres';
import { generateId } from '../../utils/id';

export interface CreateNotificationInput {
  shopId: string;
  branchId?: string | null;
  userId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
}

export interface NotificationRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  user_id: string | null;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  data: Record<string, any> | null;
  read_at: Date | null;
  created_at: Date;
}

export async function createNotification(
  input: CreateNotificationInput,
  client?: Pool | PoolClient,
): Promise<NotificationRow> {
  const exec: Pool | PoolClient = client ?? pgPool;
  if (!input.shopId) throw new Error('createNotification: shopId is required');
  const { rows } = await exec.query(
    `INSERT INTO crm_notification
       (id, shop_id, branch_id, user_id, type, title, body, entity_type, entity_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      generateId('crmntf'),
      input.shopId,
      input.branchId ?? null,
      input.userId ?? null,
      input.type,
      input.title,
      input.body ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.data == null ? null : JSON.stringify(input.data),
    ],
  );
  return rows[0] as NotificationRow;
}

export async function listNotificationsForUser(
  shopId: string,
  userId: string,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
  client?: Pool | PoolClient,
): Promise<NotificationRow[]> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const params: unknown[] = [shopId, userId];
  const unread = opts.unreadOnly ? ' AND read_at IS NULL' : '';
  const { rows } = await exec.query(
    `SELECT * FROM crm_notification
      WHERE shop_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        ${unread}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows as NotificationRow[];
}

export async function markNotificationRead(
  shopId: string,
  userId: string,
  notificationId: string,
  client?: Pool | PoolClient,
): Promise<boolean> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const res = await exec.query(
    `UPDATE crm_notification
        SET read_at = now()
      WHERE id = $1
        AND shop_id = $2
        AND (user_id = $3 OR user_id IS NULL)
        AND read_at IS NULL`,
    [notificationId, shopId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
