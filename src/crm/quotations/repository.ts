/**
 * CRM quotation — data access.
 *
 * `crm_quotation` is under FORCE row-level security (migration 016). Same
 * conventions as every other CRM repository: explicit `WHERE shop_id = $1`
 * defence-in-depth on top of RLS, tenant transaction client from
 * `withTenant(shopId, …)`.
 *
 * Foundation scope only (Slice 4): a single `amount` total, no line-items
 * table, no bridge into `orders`/`invoices`/`invoice_payments` — those stay
 * untouched. `opportunity_id` is required; every quotation exists in the
 * context of a specific deal.
 */

import type { PoolClient } from 'pg';
import { generateId } from '../../utils/id';
import type { ParsedListQuery } from '../db/listQuery';

export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const OPEN_QUOTATION_STATUSES = ['draft', 'sent'] as const;

export interface QuotationRow {
  id: string;
  shop_id: string;
  branch_id: string | null;
  opportunity_id: string;
  customer_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  title: string;
  amount: number | null;
  status: QuotationStatus;
  valid_until: string | null;
  notes: string | null;
  sent_at: Date | null;
  accepted_at: Date | null;
  rejected_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface QuotationWritable {
  branch_id?: string | null;
  opportunity_id?: string;
  customer_id?: string | null;
  assigned_to?: string | null;
  title?: string;
  amount?: number | null;
  valid_until?: string | null;
  notes?: string | null;
}

const RETURNING = '*';

export async function listQuotationsByOpportunity(
  client: PoolClient,
  shopId: string,
  opportunityId: string,
): Promise<QuotationRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM crm_quotation
      WHERE shop_id = $1 AND opportunity_id = $2 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [shopId, opportunityId],
  );
  return rows as QuotationRow[];
}

export async function listQuotations(
  client: PoolClient,
  args: { shopId: string; parsed: ParsedListQuery },
): Promise<{ rows: QuotationRow[]; total: number }> {
  const baseParams: unknown[] = [args.shopId];
  const baseConditions = ['shop_id = $1', 'deleted_at IS NULL'];

  const { text: whereText, params } = args.parsed.buildWhere({ baseConditions, baseParams });

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM crm_quotation ${whereText}`,
    params,
  );
  const total = countRows[0]?.n ?? 0;

  const { column, direction } = args.parsed.orderBy;
  const { rows } = await client.query(
    `SELECT * FROM crm_quotation ${whereText}
       ORDER BY ${column} ${direction} NULLS LAST, id ASC
       LIMIT ${args.parsed.limit} OFFSET ${args.parsed.offset}`,
    params,
  );
  return { rows: rows as QuotationRow[], total };
}

export async function getQuotationById(
  client: PoolClient,
  shopId: string,
  id: string,
  opts: { forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<QuotationRow | null> {
  const params: unknown[] = [shopId, id];
  let sql = `SELECT * FROM crm_quotation WHERE shop_id = $1 AND id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  if (opts.forUpdate) sql += ` FOR UPDATE`;
  const { rows } = await client.query(sql, params);
  return (rows[0] as QuotationRow) ?? null;
}

export async function insertQuotation(
  client: PoolClient,
  args: { shopId: string; createdBy: string | null; data: QuotationWritable & { opportunity_id: string } },
): Promise<QuotationRow> {
  const id = generateId('crmquote');
  const d = args.data;
  const { rows } = await client.query(
    `INSERT INTO crm_quotation
       (id, shop_id, branch_id, opportunity_id, customer_id, assigned_to, created_by,
        title, amount, valid_until, notes, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     RETURNING ${RETURNING}`,
    [
      id,
      args.shopId,
      d.branch_id ?? null,
      d.opportunity_id,
      d.customer_id ?? null,
      d.assigned_to ?? null,
      args.createdBy,
      d.title,
      d.amount ?? null,
      d.valid_until ?? null,
      d.notes ?? null,
    ],
  );
  return rows[0] as QuotationRow;
}

const UPDATABLE_COLUMNS: Record<'branch_id' | 'customer_id' | 'assigned_to' | 'title' | 'amount' | 'valid_until' | 'notes', string> = {
  branch_id: 'branch_id',
  customer_id: 'customer_id',
  assigned_to: 'assigned_to',
  title: 'title',
  amount: 'amount',
  valid_until: 'valid_until',
  notes: 'notes',
};

export async function updateQuotation(
  client: PoolClient,
  shopId: string,
  id: string,
  patch: Partial<QuotationWritable> & {
    status?: QuotationStatus;
    sent_at?: Date | null;
    accepted_at?: Date | null;
    rejected_at?: Date | null;
    last_activity_at?: Date | null;
  },
): Promise<QuotationRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
    if (key in patch && (patch as any)[key] !== undefined) {
      params.push((patch as any)[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of ['status', 'sent_at', 'accepted_at', 'rejected_at', 'last_activity_at'] as const) {
    if (col in patch && (patch as any)[col] !== undefined) {
      params.push((patch as any)[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getQuotationById(client, shopId, id);
  }

  params.push(shopId);
  params.push(id);
  const { rows } = await client.query(
    `UPDATE crm_quotation SET ${sets.join(', ')}, updated_at = now()
      WHERE shop_id = $${params.length - 1} AND id = $${params.length} AND deleted_at IS NULL
      RETURNING ${RETURNING}`,
    params,
  );
  return (rows[0] as QuotationRow) ?? null;
}

export async function softDeleteQuotation(client: PoolClient, shopId: string, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE crm_quotation SET deleted_at = now(), updated_at = now()
      WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [shopId, id],
  );
  return (rowCount ?? 0) > 0;
}
