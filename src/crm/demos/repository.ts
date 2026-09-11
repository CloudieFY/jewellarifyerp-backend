/**
 * CRM demo — data access.
 *
 * `crm_demo` is under FORCE row-level security (migration 015). Every
 * function here takes a tenant transaction client obtained from
 * `withTenant(shopId, …)`; the RLS policy (`shop_id = current_setting(
 * 'app.shop_id', true)`) is the real isolation boundary, and the explicit
 * `WHERE shop_id = $1` below is defence-in-depth — same convention as
 * `leads/repository.ts` / `opportunities/repository.ts`.
 *
 * A demo carries BOTH `lead_id` and `opportunity_id` as independent
 * nullable FKs (not a single polymorphic related_type/related_id pair like
 * crm_task) so a demo scheduled against a lead that later promotes to an
 * opportunity keeps its original lead lineage. The DB CHECK
 * (`crm_demo_lead_or_opportunity`) requires at least one to be set.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import type { ParsedListQuery } from '../db/listQuery';

export const DEMO_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

export interface DemoRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  lead_id: string | null;
  opportunity_id: string | null;
  customer_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  scheduled_at: Date;
  status: DemoStatus;
  mode: string | null;
  outcome: string | null;
  notes: string | null;
  next_action: string | null;
  completed_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface DemoScope {
  userId: string;
  /** Restrict to these branch ids, or null for shop-wide. */
  branchIds: string[] | null;
  /** dealer persona: only demos they own (assigned_to or created_by). */
  ownOnly: boolean;
}

export interface DemoWritable {
  branch_id?: string | null;
  lead_id?: string | null;
  opportunity_id?: string | null;
  customer_id?: string | null;
  assigned_to?: string | null;
  scheduled_at?: Date | string;
  mode?: string | null;
  notes?: string | null;
}

const RETURNING = '*';

function scopeClause(scope: DemoScope | null, params: unknown[]): string {
  if (!scope) return '';
  const parts: string[] = [];
  if (scope.branchIds) {
    params.push(scope.branchIds);
    parts.push(`branch_id = ANY($${params.length})`);
  }
  if (scope.ownOnly) {
    params.push(scope.userId);
    parts.push(`(assigned_to = $${params.length} OR created_by = $${params.length})`);
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

export async function listDemos(
  client: PoolClient,
  args: { shopId: string; scope: DemoScope | null; parsed: ParsedListQuery },
): Promise<{ rows: DemoRow[]; total: number }> {
  const baseParams: unknown[] = [args.shopId];
  const baseConditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const scopeSql = scopeClause(args.scope, baseParams);
  if (scopeSql) baseConditions.push(scopeSql.replace(/^ AND /, ''));

  const { text: whereText, params } = args.parsed.buildWhere({ baseConditions, baseParams });

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM crm_demo ${whereText}`,
    params,
  );
  const total = countRows[0]?.n ?? 0;

  const { column, direction } = args.parsed.orderBy;
  const { rows } = await client.query(
    `SELECT * FROM crm_demo ${whereText}
       ORDER BY ${column} ${direction} NULLS LAST, id ASC
       LIMIT ${args.parsed.limit} OFFSET ${args.parsed.offset}`,
    params,
  );
  return { rows: rows as DemoRow[], total };
}

export async function getDemoById(
  client: PoolClient,
  shopId: string,
  id: string,
  opts: { scope?: DemoScope | null; forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<DemoRow | null> {
  const params: unknown[] = [shopId, id];
  let sql = `SELECT * FROM crm_demo WHERE shop_id = $1 AND id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  sql += scopeClause(opts.scope ?? null, params);
  if (opts.forUpdate) sql += ` FOR UPDATE`;
  const { rows } = await client.query(sql, params);
  return (rows[0] as DemoRow) ?? null;
}

export async function insertDemo(
  client: PoolClient,
  args: { shopId: string; createdBy: string | null; data: DemoWritable },
): Promise<DemoRow> {
  const id = generateId('crmdemo');
  const d = args.data;
  const { rows } = await client.query(
    `INSERT INTO crm_demo
       (id, shop_id, branch_id, lead_id, opportunity_id, customer_id, assigned_to, created_by,
        scheduled_at, mode, notes, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     RETURNING ${RETURNING}`,
    [
      id,
      args.shopId,
      d.branch_id ?? null,
      d.lead_id ?? null,
      d.opportunity_id ?? null,
      d.customer_id ?? null,
      d.assigned_to ?? null,
      args.createdBy,
      d.scheduled_at,
      d.mode ?? null,
      d.notes ?? null,
    ],
  );
  return rows[0] as DemoRow;
}

const UPDATABLE_COLUMNS: Record<keyof DemoWritable, string> = {
  branch_id: 'branch_id',
  lead_id: 'lead_id',
  opportunity_id: 'opportunity_id',
  customer_id: 'customer_id',
  assigned_to: 'assigned_to',
  scheduled_at: 'scheduled_at',
  mode: 'mode',
  notes: 'notes',
};

export async function updateDemo(
  client: PoolClient,
  shopId: string,
  id: string,
  patch: Partial<DemoWritable> & {
    status?: DemoStatus;
    outcome?: string | null;
    next_action?: string | null;
    completed_at?: Date | null;
    last_activity_at?: Date | null;
  },
): Promise<DemoRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
    if (key in patch && (patch as any)[key] !== undefined) {
      params.push((patch as any)[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of ['status', 'outcome', 'next_action', 'completed_at', 'last_activity_at'] as const) {
    if (col in patch && (patch as any)[col] !== undefined) {
      params.push((patch as any)[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getDemoById(client, shopId, id);
  }

  params.push(shopId);
  params.push(id);
  const { rows } = await client.query(
    `UPDATE crm_demo SET ${sets.join(', ')}, updated_at = now()
      WHERE shop_id = $${params.length - 1} AND id = $${params.length} AND deleted_at IS NULL
      RETURNING ${RETURNING}`,
    params,
  );
  return (rows[0] as DemoRow) ?? null;
}

export async function softDeleteDemo(client: PoolClient, shopId: string, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE crm_demo SET deleted_at = now(), updated_at = now()
      WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return (rowCount ?? 0) > 0;
}

/** True when `id` is a live demo of this shop (RLS-scoped lookup) — used by crm_task's related_type='demo' validation. */
export async function demoBelongsToShop(client: PoolClient, shopId: string, id: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM crm_demo WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return rows.length > 0;
}
