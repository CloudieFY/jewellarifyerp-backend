/**
 * CRM lead — data access.
 *
 * `crm_lead` is under FORCE row-level security (migration 010). Every function
 * here takes a tenant transaction client obtained from
 * `withTenant(shopId, …)`; the RLS policy (`shop_id = current_setting(
 * 'app.shop_id', true)`) is the real isolation boundary, and the explicit
 * `WHERE shop_id = $1` below is defence-in-depth.
 *
 * `shopId` is always the caller's verified `req.pgTenant.shopId` — never a
 * value taken from the request body/query.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import type { ParsedListQuery } from '../db/listQuery';

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'converted',
  'lost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Phase 3 structured-qualification outcome. This is a SEPARATE axis from
 * `status` above — a NULL value means "not yet assessed". `nurture` has no
 * matching `status` value on purpose (see migration 013): a nurtured lead
 * keeps whatever open `status` it already had.
 */
export const QUALIFICATION_STATUSES = ['qualified', 'nurture', 'disqualified'] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

export interface LeadRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  customer_id: string | null;
  converted_customer_id: string | null;
  qualified_at: Date | null;
  converted_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // Phase 3 — structured qualification (migration 013)
  qualification_status: QualificationStatus | null;
  qualification_score: number | null;
  qualification_notes: string | null;
  qualification_data: Record<string, any> | null;
  qualified_by: string | null;
  disqualified_at: Date | null;
  disqualified_reason: string | null;
  nurture_until: string | null;
}

/** Server-derived visibility scope for the current user (never from input). */
export interface LeadScope {
  userId: string;
  /** Restrict to these branch ids, or null for shop-wide. */
  branchIds: string[] | null;
  /** dealer persona: only leads they own (assigned_to or created_by). */
  ownOnly: boolean;
}

export interface LeadWritable {
  name?: string;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  source?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  branch_id?: string | null;
  assigned_to?: string | null;
}

const RETURNING = '*';

function scopeClause(scope: LeadScope | null, params: unknown[]): string {
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

export async function listLeads(
  client: PoolClient,
  args: {
    shopId: string;
    scope: LeadScope | null;
    parsed: ParsedListQuery;
  },
): Promise<{ rows: LeadRow[]; total: number }> {
  const baseParams: unknown[] = [args.shopId];
  const baseConditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const scopeSql = scopeClause(args.scope, baseParams);
  if (scopeSql) baseConditions.push(scopeSql.replace(/^ AND /, ''));

  const { text: whereText, params } = args.parsed.buildWhere({ baseConditions, baseParams });

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM crm_lead ${whereText}`,
    params,
  );
  const total = countRows[0]?.n ?? 0;

  const { column, direction } = args.parsed.orderBy; // both from allow-list
  const { rows } = await client.query(
    `SELECT * FROM crm_lead ${whereText}
       ORDER BY ${column} ${direction} NULLS LAST, id ASC
       LIMIT ${args.parsed.limit} OFFSET ${args.parsed.offset}`,
    params,
  );
  return { rows: rows as LeadRow[], total };
}

export async function getLeadById(
  client: PoolClient,
  shopId: string,
  id: string,
  opts: { scope?: LeadScope | null; forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<LeadRow | null> {
  const params: unknown[] = [shopId, id];
  let sql = `SELECT * FROM crm_lead WHERE shop_id = $1 AND id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  sql += scopeClause(opts.scope ?? null, params);
  if (opts.forUpdate) sql += ` FOR UPDATE`;
  const { rows } = await client.query(sql, params);
  return (rows[0] as LeadRow) ?? null;
}

export async function insertLead(
  client: PoolClient,
  args: { shopId: string; createdBy: string | null; data: LeadWritable },
): Promise<LeadRow> {
  const id = generateId('crmlead');
  const d = args.data;
  const { rows } = await client.query(
    `INSERT INTO crm_lead
       (id, shop_id, branch_id, assigned_to, created_by,
        name, phone, email, company, source, status, notes, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'new'),$12, now())
     RETURNING ${RETURNING}`,
    [
      id,
      args.shopId,
      d.branch_id ?? null,
      d.assigned_to ?? null,
      args.createdBy,
      d.name,
      d.phone ?? null,
      d.email ?? null,
      d.company ?? null,
      d.source ?? null,
      d.status ?? null,
      d.notes ?? null,
    ],
  );
  return rows[0] as LeadRow;
}

const UPDATABLE_COLUMNS: Record<keyof LeadWritable, string> = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  company: 'company',
  source: 'source',
  status: 'status',
  notes: 'notes',
  branch_id: 'branch_id',
  assigned_to: 'assigned_to',
};

export async function updateLead(
  client: PoolClient,
  shopId: string,
  id: string,
  patch: Partial<LeadWritable> & {
    qualified_at?: Date | null;
    converted_at?: Date | null;
    converted_customer_id?: string | null;
    last_activity_at?: Date | null;
    // Phase 3 — structured qualification (migration 013)
    qualification_status?: QualificationStatus | null;
    qualification_score?: number | null;
    qualification_notes?: string | null;
    qualification_data?: Record<string, unknown> | null;
    qualified_by?: string | null;
    disqualified_at?: Date | null;
    disqualified_reason?: string | null;
    nurture_until?: string | null;
  },
): Promise<LeadRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
    if (key in patch && (patch as any)[key] !== undefined) {
      params.push((patch as any)[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of [
    'qualified_at',
    'converted_at',
    'converted_customer_id',
    'last_activity_at',
    'qualification_status',
    'qualification_score',
    'qualification_notes',
    'qualification_data',
    'qualified_by',
    'disqualified_at',
    'disqualified_reason',
    'nurture_until',
  ] as const) {
    if (col in patch && (patch as any)[col] !== undefined) {
      const value = (patch as any)[col];
      params.push(col === 'qualification_data' && value != null ? JSON.stringify(value) : value);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getLeadById(client, shopId, id);
  }

  params.push(shopId);
  params.push(id);
  const { rows } = await client.query(
    `UPDATE crm_lead SET ${sets.join(', ')}, updated_at = now()
      WHERE shop_id = $${params.length - 1} AND id = $${params.length} AND deleted_at IS NULL
      RETURNING ${RETURNING}`,
    params,
  );
  return (rows[0] as LeadRow) ?? null;
}

export async function softDeleteLead(
  client: PoolClient,
  shopId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE crm_lead SET deleted_at = now(), updated_at = now()
      WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return (rowCount ?? 0) > 0;
}

/** Dedupe helper for conversion: an existing, non-deleted customer by phone. */
export async function findCustomerByPhone(
  client: PoolClient,
  shopId: string,
  phone: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query(
    `SELECT id FROM customers
      WHERE shop_id = $1 AND phone = $2 AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [shopId, phone],
  );
  return rows[0] ?? null;
}

/** True when `branchId` is a live branch of this shop (RLS-scoped lookup). */
export async function branchBelongsToShop(
  client: PoolClient,
  shopId: string,
  branchId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM branches WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, branchId],
  );
  return rows.length > 0;
}

/** True when `userId` is a user of this shop. `users` is not under RLS -> explicit scope. */
export async function userBelongsToShop(
  client: PoolClient,
  shopId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM users WHERE shop_id = $1 AND id = $2 AND is_active = true`,
    [shopId, userId],
  );
  return rows.length > 0;
}

/**
 * Phase 3 — dedupe helper for lead -> opportunity promotion: the first
 * non-deleted opportunity already linked to this lead, or null. `crm_opportunity`
 * is under the same tenant RLS, so this is shop-safe on the tenant client.
 */
export async function findExistingOpportunityForLead(
  client: PoolClient,
  shopId: string,
  leadId: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query(
    `SELECT id FROM crm_opportunity
      WHERE shop_id = $1 AND lead_id = $2 AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [shopId, leadId],
  );
  return rows[0] ?? null;
}
