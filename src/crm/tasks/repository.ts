/**
 * CRM task — data access.
 *
 * `crm_task` is under FORCE row-level security (migration 011). Every function
 * here takes a tenant transaction client from `withTenant(shopId, …)`; the RLS
 * policy is the real isolation boundary and the explicit `WHERE shop_id = $1`
 * is defence-in-depth. Mirrors src/crm/leads/repository.ts.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import type { ParsedListQuery } from '../db/listQuery';

export const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a client may set directly — 'completed' goes through the /complete endpoint. */
export const TASK_OPEN_STATUSES = ['open', 'in_progress', 'cancelled'] as const;

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_RELATED_TYPES = ['lead', 'opportunity', 'customer', 'demo'] as const;
export type TaskRelatedType = (typeof TASK_RELATED_TYPES)[number];

export interface TaskRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  completed_by: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: Date | null;
  related_type: TaskRelatedType | null;
  related_id: string | null;
  completed_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Server-derived visibility scope for the current user (never from input). */
export interface TaskScope {
  userId: string;
  branchIds: string[] | null;
  /** dealer persona: only tasks they own (assigned_to or created_by). */
  ownOnly: boolean;
}

export interface TaskWritable {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: Date | string | null;
  related_type?: TaskRelatedType | null;
  related_id?: string | null;
  branch_id?: string | null;
  assigned_to?: string | null;
}

const RETURNING = '*';

function scopeClause(scope: TaskScope | null, params: unknown[]): string {
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

export async function listTasks(
  client: PoolClient,
  args: {
    shopId: string;
    scope: TaskScope | null;
    parsed: ParsedListQuery;
    /** `?mine=1` — restrict to tasks assigned to the current user. */
    mine?: boolean;
    /** `?overdue=1` — restrict to not-done tasks whose due date has passed. */
    overdue?: boolean;
  },
): Promise<{ rows: TaskRow[]; total: number }> {
  const baseParams: unknown[] = [args.shopId];
  const baseConditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const scopeSql = scopeClause(args.scope, baseParams);
  if (scopeSql) baseConditions.push(scopeSql.replace(/^ AND /, ''));

  if (args.mine && args.scope) {
    baseParams.push(args.scope.userId);
    baseConditions.push(`assigned_to = $${baseParams.length}`);
  }
  if (args.overdue) {
    baseConditions.push(`due_at IS NOT NULL AND due_at < now() AND status NOT IN ('completed','cancelled')`);
  }

  const { text: whereText, params } = args.parsed.buildWhere({ baseConditions, baseParams });

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM crm_task ${whereText}`,
    params,
  );
  const total = countRows[0]?.n ?? 0;

  const { column, direction } = args.parsed.orderBy; // both from allow-list
  const { rows } = await client.query(
    `SELECT * FROM crm_task ${whereText}
       ORDER BY ${column} ${direction} NULLS LAST, id ASC
       LIMIT ${args.parsed.limit} OFFSET ${args.parsed.offset}`,
    params,
  );
  return { rows: rows as TaskRow[], total };
}

export async function getTaskById(
  client: PoolClient,
  shopId: string,
  id: string,
  opts: { scope?: TaskScope | null; forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<TaskRow | null> {
  const params: unknown[] = [shopId, id];
  let sql = `SELECT * FROM crm_task WHERE shop_id = $1 AND id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  sql += scopeClause(opts.scope ?? null, params);
  if (opts.forUpdate) sql += ` FOR UPDATE`;
  const { rows } = await client.query(sql, params);
  return (rows[0] as TaskRow) ?? null;
}

export async function insertTask(
  client: PoolClient,
  args: { shopId: string; createdBy: string | null; data: TaskWritable },
): Promise<TaskRow> {
  const id = generateId('crmtask');
  const d = args.data;
  const { rows } = await client.query(
    `INSERT INTO crm_task
       (id, shop_id, branch_id, assigned_to, created_by,
        title, description, status, priority, due_at, related_type, related_id, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'open'),COALESCE($9,'medium'),$10,$11,$12, now())
     RETURNING ${RETURNING}`,
    [
      id,
      args.shopId,
      d.branch_id ?? null,
      d.assigned_to ?? null,
      args.createdBy,
      d.title,
      d.description ?? null,
      d.status ?? null,
      d.priority ?? null,
      d.due_at ?? null,
      d.related_type ?? null,
      d.related_id ?? null,
    ],
  );
  return rows[0] as TaskRow;
}

const UPDATABLE_COLUMNS: Record<keyof TaskWritable, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  due_at: 'due_at',
  related_type: 'related_type',
  related_id: 'related_id',
  branch_id: 'branch_id',
  assigned_to: 'assigned_to',
};

export async function updateTask(
  client: PoolClient,
  shopId: string,
  id: string,
  patch: Partial<TaskWritable> & {
    completed_at?: Date | null;
    completed_by?: string | null;
    last_activity_at?: Date | null;
  },
): Promise<TaskRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
    if (key in patch && (patch as any)[key] !== undefined) {
      params.push((patch as any)[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of ['completed_at', 'completed_by', 'last_activity_at'] as const) {
    if (col in patch && (patch as any)[col] !== undefined) {
      params.push((patch as any)[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getTaskById(client, shopId, id);
  }

  params.push(shopId);
  params.push(id);
  const { rows } = await client.query(
    `UPDATE crm_task SET ${sets.join(', ')}, updated_at = now()
      WHERE shop_id = $${params.length - 1} AND id = $${params.length} AND deleted_at IS NULL
      RETURNING ${RETURNING}`,
    params,
  );
  return (rows[0] as TaskRow) ?? null;
}

export async function softDeleteTask(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE crm_task SET deleted_at = now(), updated_at = now()
      WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return (rowCount ?? 0) > 0;
}
