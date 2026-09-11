import { Router, Request, Response } from 'express';
import { withTenant, withSuperAdminCrmTx } from '../../../utils/db';
import { rowToApi, rowsToApi } from '../../../db/mapping';
import { parseListQuery, type ListQueryConfig } from '../../db/listQuery';
import { recordAudit } from '../../audit/recordAudit';
import { enqueueOutbox } from '../../outbox/repository';
import { recordActivity } from '../../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../../leads/repository';
import { leadBelongsToShop, opportunityBelongsToShop, customerBelongsToShop } from '../../opportunities/repository';
import { demoBelongsToShop } from '../../demos/repository';
import {
  getTaskById,
  insertTask,
  updateTask,
  softDeleteTask,
  TASK_OPEN_STATUSES,
  TASK_PRIORITIES,
  TASK_RELATED_TYPES,
  type TaskWritable,
  type TaskRelatedType,
} from '../../tasks/repository';
import { adminActorMeta } from './_shared';

/**
 * Super Admin CRM Task API — mounted at /api/superadmin/crm/tasks. Same
 * shape as admin/leads.ts and admin/opportunities.ts.
 */

const router = Router();

const TASK_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'due_at', 'priority', 'status', 'title'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['status', 'priority', 'assigned_to', 'branch_id', 'related_type', 'related_id', 'shop_id'],
  searchable: ['title', 'description'],
  maxLimit: 100,
  defaultLimit: 25,
};

function parseDueAt(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function pickWritable(body: any): Partial<TaskWritable> {
  const out: Partial<TaskWritable> = {};
  const map: Record<string, keyof TaskWritable> = {
    title: 'title', description: 'description', status: 'status', priority: 'priority',
    dueAt: 'due_at', due_at: 'due_at', relatedType: 'related_type', related_type: 'related_type',
    relatedId: 'related_id', related_id: 'related_id', branchId: 'branch_id', branch_id: 'branch_id',
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = map[k];
    if (!col) continue;
    if (col === 'due_at') {
      const d = parseDueAt(v);
      if (d !== undefined) out.due_at = d;
    } else {
      (out as any)[col] = v === '' ? null : v;
    }
  }
  return out;
}

async function relatedExists(client: any, shopId: string, type: TaskRelatedType, id: string): Promise<boolean> {
  if (type === 'lead') return leadBelongsToShop(client, shopId, id);
  if (type === 'opportunity') return opportunityBelongsToShop(client, shopId, id);
  if (type === 'demo') return demoBelongsToShop(client, shopId, id);
  return customerBelongsToShop(client, shopId, id);
}

/* ------------------------------------------------------------------ */
/* GET /  — cross-shop list                                            */
/* ------------------------------------------------------------------ */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseListQuery(req.query as Record<string, unknown>, TASK_LIST_CONFIG);
  try {
    const { rows, total } = await withSuperAdminCrmTx(async (client) => {
      const { text: whereSql, params } = parsed.buildWhere({ baseConditions: ['deleted_at IS NULL'], baseParams: [] });
      const countRes = await client.query(`SELECT count(*)::int AS total FROM crm_task ${whereSql}`, params);
      const dataRes = await client.query(
        `SELECT sub.*, s.shop_name
           FROM (
             SELECT * FROM crm_task
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
    console.error('[GET /api/superadmin/crm/tasks] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:shopId/:id                                                     */
/* ------------------------------------------------------------------ */
router.get('/:shopId/:id', async (req: Request, res: Response) => {
  try {
    const task = await withTenant(req.params.shopId, (client) => getTaskById(client, req.params.shopId, req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(rowToApi(task));
  } catch (err: any) {
    console.error('[GET /api/superadmin/crm/tasks/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId  — create                                             */
/* ------------------------------------------------------------------ */
router.post('/:shopId', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const data = pickWritable(req.body);
  const assignedToRaw = req.body?.assignedTo ?? req.body?.assigned_to;

  if (!data.title || String(data.title).trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (data.status && !TASK_OPEN_STATUSES.includes(data.status as any)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_OPEN_STATUSES.join(', ')} (use /complete to finish)` });
  }
  if (data.priority && !TASK_PRIORITIES.includes(data.priority as any)) {
    return res.status(400).json({ error: `priority must be one of: ${TASK_PRIORITIES.join(', ')}` });
  }
  const relType = data.related_type ?? null;
  const relId = data.related_id ?? null;
  if ((relType == null) !== (relId == null)) {
    return res.status(400).json({ error: 'relatedType and relatedId must be provided together' });
  }
  if (relType && !TASK_RELATED_TYPES.includes(relType as any)) {
    return res.status(400).json({ error: `relatedType must be one of: ${TASK_RELATED_TYPES.join(', ')}` });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const branchId: string | null = data.branch_id ?? null;
      if (branchId && !(await branchBelongsToShop(client, shopId, branchId))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      if (relType && relId && !(await relatedExists(client, shopId, relType as TaskRelatedType, String(relId)))) {
        return { err: { status: 400, msg: `related ${relType} does not belong to this shop` } };
      }
      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }

      const task = await insertTask(client, { shopId, createdBy: null, data: { ...data, branch_id: branchId, assigned_to: assignedTo } });

      if (task.related_type && task.related_id) {
        await recordActivity(client, {
          shopId, branchId, entityType: task.related_type, entityId: task.related_id, type: 'system',
          body: `Task created by Super Admin: ${task.title}`, data: { taskId: task.id, ...adminActorMeta(req) }, actorUserId: null,
        });
      }
      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'task', entityId: task.id, action: 'create', after: task, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'task.created', payload: { taskId: task.id, assignedTo }, dedupeKey: `task.created:${task.id}` },
        client,
      );
      return { task };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(rowToApi(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/tasks/:shopId] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create task' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:shopId/:id                                                   */
/* ------------------------------------------------------------------ */
router.patch('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to;
  if (patch.status && !TASK_OPEN_STATUSES.includes(patch.status as any)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_OPEN_STATUSES.join(', ')} (use /complete to finish)` });
  }

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getTaskById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if ('branch_id' in patch && patch.branch_id && !(await branchBelongsToShop(client, shopId, patch.branch_id))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }

      const updated = await updateTask(client, shopId, req.params.id, patch);
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'task', entityId: updated.id, action: 'update', before, after: updated, metadata: adminActorMeta(req) },
        client,
      );
      return { task: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.task));
  } catch (err: any) {
    console.error('[PATCH /api/superadmin/crm/tasks/:shopId/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update task' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /:shopId/:id  (soft delete)                                  */
/* ------------------------------------------------------------------ */
router.delete('/:shopId/:id', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getTaskById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      const ok = await softDeleteTask(client, shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        { shopId, branchId: before.branch_id, actorUserId: null, entityType: 'task', entityId: before.id, action: 'delete', before, metadata: adminActorMeta(req) },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Task deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/superadmin/crm/tasks/:shopId/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/assign                                            */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/assign', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  const branchIdRaw = req.body?.branchId ?? req.body?.branch_id;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getTaskById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if (before.status === 'completed') {
        return { err: { status: 409, msg: 'A completed task cannot be reassigned' } };
      }
      if (!(await userBelongsToShop(client, shopId, String(assignedTo)))) {
        return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
      }
      let branchId = before.branch_id;
      if (branchIdRaw) {
        if (!(await branchBelongsToShop(client, shopId, String(branchIdRaw)))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        branchId = String(branchIdRaw);
      }

      const updated = await updateTask(client, shopId, req.params.id, { assigned_to: String(assignedTo), branch_id: branchId, last_activity_at: new Date() });
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        { shopId, branchId, actorUserId: null, entityType: 'task', entityId: updated.id, action: 'assign', before: { assigned_to: before.assigned_to }, after: { assigned_to: updated.assigned_to }, metadata: adminActorMeta(req) },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'task.assigned', payload: { taskId: updated.id, assignedTo: String(assignedTo) }, dedupeKey: `task.assigned:${updated.id}:${assignedTo}` },
        client,
      );
      return { task: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/tasks/:shopId/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign task' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:shopId/:id/complete                                          */
/* ------------------------------------------------------------------ */
router.post('/:shopId/:id/complete', async (req: Request, res: Response) => {
  const shopId = req.params.shopId;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

  try {
    const outcome = await withTenant(shopId, async (client) => {
      const before = await getTaskById(client, shopId, req.params.id, { forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if (before.status === 'completed') return { task: before };

      const updated = await updateTask(client, shopId, req.params.id, {
        status: 'completed', completed_at: new Date(), completed_by: null, last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      if (updated.related_type && updated.related_id) {
        await recordActivity(client, {
          shopId, branchId: updated.branch_id, entityType: updated.related_type, entityId: updated.related_id, type: 'completion',
          body: `Task completed by Super Admin: ${updated.title}${note ? ` — ${note}` : ''}`,
          data: { taskId: updated.id, ...adminActorMeta(req) }, actorUserId: null,
        });
      }
      await recordAudit(
        { shopId, branchId: updated.branch_id, actorUserId: null, entityType: 'task', entityId: updated.id, action: 'complete', before: { status: before.status }, after: { status: 'completed' }, metadata: { note: note || null, ...adminActorMeta(req) } },
        client,
      );
      await enqueueOutbox(
        { shopId, eventType: 'task.completed', payload: { taskId: updated.id, createdBy: updated.created_by }, dedupeKey: `task.completed:${updated.id}` },
        client,
      );
      return { task: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(rowToApi(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/superadmin/crm/tasks/:shopId/:id/complete] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to complete task' });
  }
});

export default router;
