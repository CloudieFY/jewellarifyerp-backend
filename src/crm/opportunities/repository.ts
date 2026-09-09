/**
 * CRM opportunity (sales pipeline) — data access.
 *
 * `crm_opportunity` is under FORCE row-level security (migration 011). Every
 * function here takes a tenant transaction client from `withTenant(shopId, …)`;
 * the RLS policy (`shop_id = current_setting('app.shop_id', true)`) is the real
 * isolation boundary and the explicit `WHERE shop_id = $1` below is
 * defence-in-depth.
 *
 * `shopId` is always the caller's verified `req.pgTenant.shopId` — never a
 * value taken from the request body/query. Mirrors src/crm/leads/repository.ts.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import type { ParsedListQuery } from '../db/listQuery';

export const OPPORTUNITY_STAGES = [
  'prospecting',
  'qualification',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/** Stages a client may move an opportunity to directly (win/lose have their own endpoints). */
export const OPEN_OPPORTUNITY_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation'] as const;
export const TERMINAL_OPPORTUNITY_STAGES = ['won', 'lost'] as const;

export interface OpportunityRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  lead_id: string | null;
  customer_id: string | null;
  title: string;
  stage: OpportunityStage;
  amount: number | null;
  probability: number | null;
  source: string | null;
  notes: string | null;
  expected_close_date: string | null;
  won_at: Date | null;
  lost_at: Date | null;
  lost_reason: string | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Server-derived visibility scope for the current user (never from input). */
export interface OpportunityScope {
  userId: string;
  /** Restrict to these branch ids, or null for shop-wide. */
  branchIds: string[] | null;
  /** dealer persona: only opportunities they own (assigned_to or created_by). */
  ownOnly: boolean;
}

export interface OpportunityWritable {
  title?: string;
  stage?: OpportunityStage;
  amount?: number | null;
  probability?: number | null;
  source?: string | null;
  notes?: string | null;
  expected_close_date?: string | null;
  branch_id?: string | null;
  customer_id?: string | null;
  lead_id?: string | null;
  assigned_to?: string | null;
}

const RETURNING = '*';

function scopeClause(scope: OpportunityScope | null, params: unknown[]): string {
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

export async function listOpportunities(
  client: PoolClient,
  args: {
    shopId: string;
    scope: OpportunityScope | null;
    parsed: ParsedListQuery;
  },
): Promise<{ rows: OpportunityRow[]; total: number }> {
  const baseParams: unknown[] = [args.shopId];
  const baseConditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const scopeSql = scopeClause(args.scope, baseParams);
  if (scopeSql) baseConditions.push(scopeSql.replace(/^ AND /, ''));

  const { text: whereText, params } = args.parsed.buildWhere({ baseConditions, baseParams });

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM crm_opportunity ${whereText}`,
    params,
  );
  const total = countRows[0]?.n ?? 0;

  const { column, direction } = args.parsed.orderBy; // both from allow-list
  const { rows } = await client.query(
    `SELECT * FROM crm_opportunity ${whereText}
       ORDER BY ${column} ${direction} NULLS LAST, id ASC
       LIMIT ${args.parsed.limit} OFFSET ${args.parsed.offset}`,
    params,
  );
  return { rows: rows as OpportunityRow[], total };
}

export async function getOpportunityById(
  client: PoolClient,
  shopId: string,
  id: string,
  opts: { scope?: OpportunityScope | null; forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<OpportunityRow | null> {
  const params: unknown[] = [shopId, id];
  let sql = `SELECT * FROM crm_opportunity WHERE shop_id = $1 AND id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  sql += scopeClause(opts.scope ?? null, params);
  if (opts.forUpdate) sql += ` FOR UPDATE`;
  const { rows } = await client.query(sql, params);
  return (rows[0] as OpportunityRow) ?? null;
}

export async function insertOpportunity(
  client: PoolClient,
  args: { shopId: string; createdBy: string | null; data: OpportunityWritable },
): Promise<OpportunityRow> {
  const id = generateId('crmopp');
  const d = args.data;
  const { rows } = await client.query(
    `INSERT INTO crm_opportunity
       (id, shop_id, branch_id, assigned_to, created_by, lead_id, customer_id,
        title, stage, amount, probability, source, notes, expected_close_date, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'prospecting'),$10,$11,$12,$13,$14, now())
     RETURNING ${RETURNING}`,
    [
      id,
      args.shopId,
      d.branch_id ?? null,
      d.assigned_to ?? null,
      args.createdBy,
      d.lead_id ?? null,
      d.customer_id ?? null,
      d.title,
      d.stage ?? null,
      d.amount ?? null,
      d.probability ?? null,
      d.source ?? null,
      d.notes ?? null,
      d.expected_close_date ?? null,
    ],
  );
  return rows[0] as OpportunityRow;
}

const UPDATABLE_COLUMNS: Record<keyof OpportunityWritable, string> = {
  title: 'title',
  stage: 'stage',
  amount: 'amount',
  probability: 'probability',
  source: 'source',
  notes: 'notes',
  expected_close_date: 'expected_close_date',
  branch_id: 'branch_id',
  customer_id: 'customer_id',
  lead_id: 'lead_id',
  assigned_to: 'assigned_to',
};

export async function updateOpportunity(
  client: PoolClient,
  shopId: string,
  id: string,
  patch: Partial<OpportunityWritable> & {
    won_at?: Date | null;
    lost_at?: Date | null;
    lost_reason?: string | null;
    last_activity_at?: Date | null;
  },
): Promise<OpportunityRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
    if (key in patch && (patch as any)[key] !== undefined) {
      params.push((patch as any)[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of ['won_at', 'lost_at', 'lost_reason', 'last_activity_at'] as const) {
    if (col in patch && (patch as any)[col] !== undefined) {
      params.push((patch as any)[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getOpportunityById(client, shopId, id);
  }

  params.push(shopId);
  params.push(id);
  const { rows } = await client.query(
    `UPDATE crm_opportunity SET ${sets.join(', ')}, updated_at = now()
      WHERE shop_id = $${params.length - 1} AND id = $${params.length} AND deleted_at IS NULL
      RETURNING ${RETURNING}`,
    params,
  );
  return (rows[0] as OpportunityRow) ?? null;
}

export async function softDeleteOpportunity(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE crm_opportunity SET deleted_at = now(), updated_at = now()
      WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return (rowCount ?? 0) > 0;
}

export interface PipelineStageSummary {
  stage: OpportunityStage;
  count: number;
  amount: number;
}

/**
 * Per-stage count + summed amount for the pipeline board. Honours the same
 * visibility scope as the list, plus optional branch / assignee narrowing
 * (both already validated / server-derived by the caller).
 */
export async function pipelineSummary(
  client: PoolClient,
  args: {
    shopId: string;
    scope: OpportunityScope | null;
    branchId?: string | null;
    assignedTo?: string | null;
  },
): Promise<PipelineStageSummary[]> {
  const params: unknown[] = [args.shopId];
  const conditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const scopeSql = scopeClause(args.scope, params);
  if (scopeSql) conditions.push(scopeSql.replace(/^ AND /, ''));

  if (args.branchId) {
    params.push(args.branchId);
    conditions.push(`branch_id = $${params.length}`);
  }
  if (args.assignedTo) {
    params.push(args.assignedTo);
    conditions.push(`assigned_to = $${params.length}`);
  }

  const { rows } = await client.query(
    `SELECT stage, count(*)::int AS count, COALESCE(sum(amount), 0)::numeric AS amount
       FROM crm_opportunity
      WHERE ${conditions.join(' AND ')}
      GROUP BY stage`,
    params,
  );

  const byStage = new Map<string, { count: number; amount: number }>(
    rows.map((r: any) => [r.stage, { count: r.count, amount: Number(r.amount) }]),
  );
  return OPPORTUNITY_STAGES.map((stage) => ({
    stage,
    count: byStage.get(stage)?.count ?? 0,
    amount: byStage.get(stage)?.amount ?? 0,
  }));
}

/** True when `id` is a live opportunity of this shop (RLS-scoped lookup). */
export async function opportunityBelongsToShop(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM crm_opportunity WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return rows.length > 0;
}

/** True when `id` is a live lead of this shop (RLS-scoped lookup). */
export async function leadBelongsToShop(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM crm_lead WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return rows.length > 0;
}

/**
 * True when `id` is a live customer of this shop. `customers` is NOT under RLS
 * (legacy ERP reads it on the bare pool) -> explicit shop scope.
 */
export async function customerBelongsToShop(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM customers WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return rows.length > 0;
}
