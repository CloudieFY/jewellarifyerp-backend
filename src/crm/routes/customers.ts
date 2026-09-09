import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowToApi, rowsToApi } from '../../db/mapping';
import { requireCrmPermission } from '../middleware/requireCrmPermission';
import { parseListQuery, assertNoClientShopScope, type ListQueryConfig } from '../db/listQuery';
import { recordAudit } from '../audit/recordAudit';
import { recordActivity, listActivity, type ActivityType } from '../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../leads/repository';

/**
 * CRM view over the EXISTING ERP `customers` table — it is NOT a second
 * customer store. These endpoints expose the CRM master fields
 * (added additively in migration 010) and the activity timeline, gated by the
 * `customer.*` permission catalogue.
 *
 * `customers` is deliberately not under RLS (legacy ERP routes read it on the
 * bare pool), so every query here carries an explicit
 * `WHERE shop_id = $1` with the verified `req.pgTenant.shopId`.
 */

const router = Router();

const CUSTOMER_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'name', 'status'],
  defaultSort: { column: 'name', direction: 'ASC' },
  filterable: ['status', 'source', 'assigned_to', 'branch_id', 'segment_id'],
  searchable: ['name', 'phone', 'email'],
  maxLimit: 100,
  defaultLimit: 25,
};

const CRM_CUSTOMER_FIELDS: Record<string, string> = {
  email: 'email',
  status: 'status',
  source: 'source',
  assignedTo: 'assigned_to',
  assigned_to: 'assigned_to',
  segmentId: 'segment_id',
  segment_id: 'segment_id',
  dob: 'dob',
  anniversary: 'anniversary',
  branchId: 'branch_id',
  branch_id: 'branch_id',
  notes: 'notes',
};

const CUSTOMER_STATUSES = ['active', 'inactive', 'prospect'];

function guardShopScope(req: Request, res: Response): boolean {
  try {
    assertNoClientShopScope(req.body as Record<string, unknown>);
    assertNoClientShopScope(req.query as Record<string, unknown>);
    return true;
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Invalid request scope' });
    return false;
  }
}

router.get('/', ...requireCrmPermission('customer', 'view'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const parsed = parseListQuery(req.query as Record<string, unknown>, CUSTOMER_LIST_CONFIG);
  try {
    const { rows, total } = await withTenant(ctx.shopId, async (client) => {
      const { text, params } = parsed.buildWhere({
        baseConditions: ['shop_id = $1', 'deleted_at IS NULL'],
        baseParams: [ctx.shopId],
      });
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM customers ${text}`,
        params,
      );
      const { column, direction } = parsed.orderBy;
      const { rows: dataRows } = await client.query(
        `SELECT * FROM customers ${text}
           ORDER BY ${column} ${direction} NULLS LAST, id ASC
           LIMIT ${parsed.limit} OFFSET ${parsed.offset}`,
        params,
      );
      return { rows: dataRows, total: countRows[0]?.n ?? 0 };
    });
    res.json({
      data: rowsToApi(rows),
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
    });
  } catch (err: any) {
    console.error('[GET /api/crm/customers] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

router.get('/:id', ...requireCrmPermission('customer', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const row = await withTenant(ctx.shopId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM customers WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.shopId, req.params.id],
      );
      return rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Customer not found' });
    res.json(rowToApi(row));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

router.patch('/:id', ...requireCrmPermission('customer', 'update'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const patch: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    const col = CRM_CUSTOMER_FIELDS[k];
    if (col && !(col in patch)) patch[col] = v === '' ? null : v;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No updatable CRM customer fields supplied' });
  }
  if (patch.status && !CUSTOMER_STATUSES.includes(String(patch.status))) {
    return res.status(400).json({ error: `status must be one of: ${CUSTOMER_STATUSES.join(', ')}` });
  }
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const { rows: beforeRows } = await client.query(
        `SELECT * FROM customers WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.shopId, req.params.id],
      );
      const before = beforeRows[0];
      if (!before) return { err: { status: 404, msg: 'Customer not found' } };
      if (patch.branch_id) {
        if (!(await branchBelongsToShop(client, ctx.shopId, String(patch.branch_id)))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
      }
      if (patch.assigned_to) {
        if (!(await userBelongsToShop(client, ctx.shopId, String(patch.assigned_to)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
      }
      const cols = Object.keys(patch);
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map((c) => patch[c]);
      const { rows } = await client.query(
        `UPDATE customers SET ${setSql}, updated_at = now()
          WHERE shop_id = $${cols.length + 1} AND id = $${cols.length + 2}
          RETURNING *`,
        [...values, ctx.shopId, req.params.id],
      );
      const after = rows[0];
      await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: after.branch_id ?? null,
        entityType: 'customer',
        entityId: after.id,
        type: 'note',
        body: 'Customer CRM fields updated',
        data: { changed: cols },
        actorUserId: ctx.user.id,
      });
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: after.branch_id ?? null,
          actorUserId: ctx.user.id,
          entityType: 'customer',
          entityId: after.id,
          action: 'update',
          before,
          after,
        },
        client,
      );
      return { customer: after };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.customer));
  } catch (err: any) {
    console.error('[PATCH /api/crm/customers/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update customer' });
  }
});

router.get('/:id/activities', ...requireCrmPermission('customer', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const payload = await withTenant(ctx.shopId, async (client) => {
      const { rows: exists } = await client.query(
        `SELECT 1 FROM customers WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.shopId, req.params.id],
      );
      if (exists.length === 0) return null;
      return listActivity(client, ctx.shopId, 'customer', req.params.id, { limit, offset });
    });
    if (!payload) return res.status(404).json({ error: 'Customer not found' });
    res.json({ data: rowsToApi(payload.rows), total: payload.total, limit, offset });
  } catch (err: any) {
    console.error('[GET /api/crm/customers/:id/activities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/:id/activities', ...requireCrmPermission('customer', 'update'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const allowedTypes: ActivityType[] = ['note', 'call', 'email', 'meeting'];
  const type: ActivityType = allowedTypes.includes(req.body?.type) ? req.body.type : 'note';
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const { rows: cRows } = await client.query(
        `SELECT branch_id FROM customers WHERE shop_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.shopId, req.params.id],
      );
      if (cRows.length === 0) return { err: { status: 404, msg: 'Customer not found' } };
      const activity = await recordActivity(client, {
        shopId: ctx.shopId,
        branchId: cRows[0].branch_id ?? null,
        entityType: 'customer',
        entityId: req.params.id,
        type,
        body,
        actorUserId: ctx.user.id,
      });
      return { activity };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.activity));
  } catch (err: any) {
    console.error('[POST /api/crm/customers/:id/activities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to add activity' });
  }
});

export default router;
