/**
 * CRM activity timeline — data access.
 *
 * Polymorphic: one row per event on a `lead`, `customer`, `opportunity` or
 * `task`. Tenant-scoped (shop_id NOT NULL) and under FORCE RLS
 * (migrations 010/011) — every function therefore requires a tenant
 * transaction client from `withTenant(shopId, …)`.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';

export type ActivityEntityType = 'lead' | 'customer' | 'opportunity' | 'task' | 'demo' | 'quotation';

export type ActivityType =
  | 'note'
  | 'status_change'
  | 'assignment'
  | 'qualification'
  | 'conversion'
  | 'call'
  | 'email'
  | 'meeting'
  | 'system'
  | 'stage_change'
  | 'won'
  | 'lost'
  | 'completion'
  | 'promotion';

export interface ActivityRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  entity_type: ActivityEntityType;
  entity_id: string;
  type: ActivityType;
  body: string | null;
  data: Record<string, any> | null;
  actor_user_id: string | null;
  created_at: Date;
}

export interface RecordActivityInput {
  shopId: string;
  branchId?: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  type: ActivityType;
  body?: string | null;
  data?: Record<string, unknown> | null;
  actorUserId?: string | null;
}

export async function recordActivity(
  client: PoolClient,
  input: RecordActivityInput,
): Promise<ActivityRow> {
  if (!input.shopId) throw new Error('recordActivity: shopId is required');
  const { rows } = await client.query(
    `INSERT INTO crm_activity
       (id, shop_id, branch_id, entity_type, entity_id, type, body, data, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      generateId('crmact'),
      input.shopId,
      input.branchId ?? null,
      input.entityType,
      input.entityId,
      input.type,
      input.body ?? null,
      input.data == null ? null : JSON.stringify(input.data),
      input.actorUserId ?? null,
    ],
  );
  return rows[0] as ActivityRow;
}

export async function listActivity(
  client: PoolClient,
  shopId: string,
  entityType: ActivityEntityType,
  entityId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: ActivityRow[]; total: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n
       FROM crm_activity
      WHERE shop_id = $1 AND entity_type = $2 AND entity_id = $3`,
    [shopId, entityType, entityId],
  );
  const total = countRows[0]?.n ?? 0;

  const { rows } = await client.query(
    `SELECT * FROM crm_activity
      WHERE shop_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [shopId, entityType, entityId],
  );
  return { rows: rows as ActivityRow[], total };
}
