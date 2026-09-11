import { Router, Request, Response } from 'express';
import { withTenant, withSuperAdminCrmTx } from '../../../utils/db';
import { rowToApi, rowsToApi } from '../../../db/mapping';
import { parseListQuery, type ListQueryConfig } from '../../db/listQuery';
import { recordAudit } from '../../audit/recordAudit';
import { enqueueOutbox } from '../../outbox/repository';
import { recordActivity, listActivity, type ActivityType } from '../../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../../leads/repository';
import { opportunityBelongsToShop, customerBelongsToShop } from '../../opportunities/repository';
import {
  listQuotationsByOpportunity,
  getQuotationById,
  insertQuotation,
  updateQuotation,
  OPEN_QUOTATION_STATUSES,
  type QuotationWritable,
} from '../../quotations/repository';
import { adminActorMeta } from './_shared';

const NUMERIC = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Super Admin CRM Quotation API — mounted at /api/superadmin/crm/quotations.
 * Foundation scope (Slice 4): every quotation belongs to exactly one
 * opportunity. Frontend surface is the "Quotations" panel on the Opportunity
 * Detail page (GET /by-opportunity/:shopId/:opportunityId is the primary
 * list call it uses) — a dedicated cross-shop list/detail route can be
 * added later without any schema change, so `GET /` and `GET /:shopId/:id`
 * are included now for that future use even though today's frontend only
 * calls the by-opportunity endpoint.
 */

const router = Router();

const QUOTATION_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'amount', 'status', 'valid_until'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['status', 'assigned_to', 'branch_id', 'opportunity_id', 'customer_id', 'shop_id'],
  searchable: ['title', 'notes'],
  maxLimit: 100,
  defaultLimit: 25,
};

function pickWritable(body: any): Partial<QuotationWritable> {
  const out: Partial<QuotationWritable> = {};
  const map: Record<string, keyof QuotationWritable> = {
    branchId: 'branch_id', branch_id: 'branch_id',
    opportunityId: 'opportunity_id', opportunity_id: 'opportunity_id',
    customerId: 'customer_id', customer_id: 'customer_id',
    title: 'title',
    amount: 'amount',
    validUntil: 'valid_until', valid_until: 'valid_until',
    notes: 'notes',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (!col) continue;
    if (col === 'amount') (out as any)[col] = NUMERIC(v);
    else (out as any)[col] = v === '' ? null : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* GET /  — cross-shop list (future dedicated list page)                */
/* ------------------------------------------------------------------ */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseListQuery(req.query as Record<string, unknown>, QUOTATION_LIST_CONFIG);
  try {
    const { rows, total } = await withSuperAdminCrmTx(async (client) => {
      const { text: whereSql, params } = parsed.buildWhere({ baseConditions: ['deleted_at IS NULL'], baseParams: [] });
      const countRes = await client.query(`SELECT count(*)::int AS total FROM crm_quotation ${whereSql}`, params);
      const dataRes = await client.query(
        `SELECT sub.*, s.shop_name
           FROM (
             SELECT * FROM crm_quotation
             ${whereSql}
             ORDER BY ${parsed.orderBy.column} ${parsed.orderBy.direction} NULLS LAST, id ASC
             LIMIT ${parsed.limit} OFFSET ${parsed.offset}
           ) sub
           JOIN shops s ON s.id = sub.shop_id`,
        params,
      );
      return { rows: dataRes.rows, total: countRes.rows[0].total as number };
    });
    res.json({ data: rowsToApi(rows), page: parsed.page, limit: parsed.limit, total, totalPages: Math.max(1, Math.ceil(total / parsed.limit)) });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/quotations] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list quotations' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /by-opportunity/:shopId/:opportunityId — the Opportunity Detail  */
/* page's "Quotations" panel primary call                               */
/* ------------------------------------------------------------------ */
router.get('/by-opportunity/:shopId/:opportunityId', async (req: Request, res: Response) => {
  const { shopId, opportunityId } = req.params;
  try {
    const outcome = await withTenant(shopId, async (client) => {
      if (!(await opportunityBelongsToShop(client, shopId, opportunityId))) return null;
      return listQuotationsByOpportunity(client, shopId, opportunityId);
    });
    if (outcome === null) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(rowsToApi(outcome));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/quotations/by-opportunity/:shopId/:opportunityId] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list quotations' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:shopId/:id                                                     */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id', async (req: Request, res: Response) => {
  try {
    const q = await withTenant(req.params.shopId, (client) => getQuotationById(client, req.params.shopId, req.params.id));
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    res.json(rowToApi(q));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/quotations/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch quotation' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId  — create (requires opportunityId)                     */
/* ------------------------------------------------------------------ */
router.post('/:shopId', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const data = pickWritable(req.body);

  if (!data.title || String(data.title).trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!data.opportunity_id) {
    return res.status(400).json({ error: 'opportunityId is required' });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      if (!(await opportunityBelongsToShop(client, shopId, data.opportunity_id!))) {
        return { err: { status: 400, msg: 'opportunity_id does not belong to this shop' } };
      }
      if (data.branch_id && !(await branchBelongsToShop(client, shopId, data.branch_id))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      if (data.customer_id && !(await customerBelongsToShop(client, shopId, data.customer_id))) {
        return { err: { status: 400, msg: 'customer_id does not belong to this shop' } };
      }

      const q = await insertQuotation(client, {
        shopId, createdBy: null,
        data: { ...data, opportunity_id: data.opportunity_id! },
      });

      await recordActivity(client, {
        shopId, branchId: q.branch_id, entityType: 'quotation', entityId: q.id, type: 'system',
        body: 'Quotation created by Super Admin', data: adminActorMeta(req), actorUserId: null,
      });
      // also visible on the opportunity's own timeline
      await recordActivity(client, {
        shopId, branchId: q.branch_id, entityType: 'opportunity', entityId: q.opportunity_id, type: 'note',
        body: `Quotation "${q.title}" created`, data: { quotationId: q.id, ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: q.branch_id, actorUserId: null, entityType: 'quotation', entityId: q.id, action: 'create', after: q, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'quotation.created', payload: { quotationId: q.id, opportunityId: q.opportunity_id }, dedupeKey: `quotation.created:${q.id}` },
        client,
      );
      return { q };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.q));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/quotations/:shopId] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create quotation' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:shopId/:id  — edit while draft/sent only                     */
/* ------------------------------------------------------------------ */
router.patch('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const patch = pickWritable(req.body);
  delete (patch as any).opportunity_id; // the opportunity a quotation belongs to is immutable

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getQuotationById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Quotation not found' } };
      if (!OPEN_QUOTATION_STATUSES.includes(before.status as any)) {
        return { err: { status: 409, msg: `Cannot edit a quotation that is already ${before.status}` } };
      }
      if (patch.branch_id && !(await branchBelongsToShop(client, shopId, patch.branch_id))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      if (patch.customer_id && !(await customerBelongsToShop(client, shopId, patch.customer_id))) {
        return { err: { status: 400, msg: 'customer_id does not belong to this shop' } };
      }

      const updated = await updateQuotation(client, shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Quotation not found' } };

      await recordActivity(client, {
        shopId, branchId: updated.branch_id, entityType: 'quotation', entityId: updated.id, type: 'note',
        body: 'Quotation updated by Super Admin', data: { changed: Object.keys(patch), ...adminActorMeta(req) }, actorUserId: null,
      });
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'quotation', entityId: updated.id, action: 'update', before, after: updated, metadata: adminActorMeta(req) },
        client,
      );
      return { q: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.q));
  } catch (err: any) {
    console.error('[PATCH /api/superadmin/crm/quotations/:shopId/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update quotation' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/send  &  /accept  &  /reject                       */
/* ------------------------------------------------------------------ */
function transitionHandler(kind: 'sent' | 'accepted' | 'rejected', fromStatuses: readonly string[]) {
  return async (req: Request, res: Response) => {
    const shopId = req.params.shopId;
    try {
      const outcome = await withTenant(shopId, async (client) => {
        const before = await getQuotationById(client, shopId, req.params.id, { forUpdate: true });
        if (!before) return { err: { status: 404, msg: 'Quotation not found' } };
        if (!fromStatuses.includes(before.status)) {
          return { err: { status: 409, msg: `Cannot mark ${kind} from status ${before.status}` } };
        }

        const stampCol = kind === 'sent' ? 'sent_at' : kind === 'accepted' ? 'accepted_at' : 'rejected_at';
        const updated = await updateQuotation(client, shopId, req.params.id, {
          status: kind, [stampCol]: new Date(), last_activity_at: new Date(),
        } as any);
        if (!updated) return { err: { status: 404, msg: 'Quotation not found' } };

        await recordActivity(client, {
          shopId, branchId: updated.branch_id, entityType: 'quotation', entityId: updated.id, type: 'status_change',
          body: `Quotation marked ${kind} by Super Admin`, data: adminActorMeta(req), actorUserId: null,
        });
        await recordAudit(
          { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'quotation', entityId: updated.id, action: kind, before: { status: before.status }, after: { status: kind }, metadata: adminActorMeta(req) },
          client,
        );
        await enqueueOutbox(
          { shopId, eventType: `quotation.${kind}`, payload: { quotationId: updated.id, opportunityId: updated.opportunity_id }, dedupeKey: `quotation.${kind}:${updated.id}` },
          client,
        );
        return { q: updated };
      });

      if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
      res.json(rowToApi(outcome.q));
    } catch (err: any) {
      console.error(`[POST /api/superadmin/crm/quotations/:shopId/:id/${kind}] failed:`, err?.message || err);
      res.status(400).json({ error: err?.message || `Failed to mark quotation ${kind}` });
    }
  };
}
router.post('/:shopId/:id/send', transitionHandler('sent', ['draft']));
router.post('/:shopId/:id/accept', transitionHandler('accepted', ['sent']));
router.post('/:shopId/:id/reject', transitionHandler('rejected', ['sent']));

/* ------------------------------------------------------------------ */
/* GET / POST /:shopId/:id/activities                                  */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id/activities', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const payload = await withTenant(shopId, async (client) => {
      const q = await getQuotationById(client, shopId, req.params.id);
      if (!q) return null;
      const { rows, total } = await listActivity(client, shopId, 'quotation', req.params.id, { limit, offset });
      return { rows, total };
    });
    if (!payload) return res.status(404).json({ error: 'Quotation not found' });
    res.json({ data: rowsToApi(payload.rows), total: payload.total, limit, offset });
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/quotations/:shopId/:id/activities] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/:shopId/:id/activities', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const allowedTypes: ActivityType[] = ['note', 'call', 'email', 'meeting'];
  const type: ActivityType = allowedTypes.includes(req.body?.type) ? req.body.type : 'note';
  if (!body) return res.status(400).json({ error: 'body is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const q = await getQuotationById(client, shopId, req.params.id, { forUpdate: true });
      if (!q) return { err: { status: 404, msg: 'Quotation not found' } };

      const activity = await recordActivity(client, {
        shopId, branchId: q.branch_id, entityType: 'quotation', entityId: q.id, type,
        body: `${body} (Super Admin)`, data: adminActorMeta(req), actorUserId: null,
      });
      await updateQuotation(client, shopId, q.id, { last_activity_at: new Date() });
      return { activity };
    });
    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.activity));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/quotations/:shopId/:id/activities] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to add activity' });
  }
});

export default router;
