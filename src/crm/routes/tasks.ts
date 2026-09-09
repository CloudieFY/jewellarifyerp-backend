import { Router, Request, Response } from 'express';
import { withTenant } from '../../utils/db';
import { rowToApi, rowsToApi } from '../../db/mapping';
import { requireCrmPermission } from '../middleware/requireCrmPermission';
import { parseListQuery, assertNoClientShopScope, type ListQueryConfig } from '../db/listQuery';
import { recordAudit } from '../audit/recordAudit';
import { enqueueOutbox } from '../outbox/repository';
import { recordActivity } from '../activity/repository';
import { branchBelongsToShop, userBelongsToShop } from '../leads/repository';
import { leadBelongsToShop, opportunityBelongsToShop, customerBelongsToShop } from '../opportunities/repository';
import {
  listTasks,
  getTaskById,
  insertTask,
  updateTask,
  softDeleteTask,
  TASK_OPEN_STATUSES,
  TASK_PRIORITIES,
  TASK_RELATED_TYPES,
  type TaskScope,
  type TaskRow,
  type TaskWritable,
  type TaskRelatedType,
} from '../tasks/repository';
import type { PgTenantContext } from '../../middleware/authPg';
import type { PoolClient } from 'pg';

/**
 * CRM Task API — mounted at /api/crm/tasks by src/crm/routes/index.ts.
 *
 * Same guarantees as the Phase 1 lead routes: permission-gated, shop scope
 * from the JWT only, runs inside withTenant() (crm_task RLS), branch / dealer
 * scope applied server-side, audit + outbox on every write. Completing a task
 * that is linked to a lead / opportunity / customer also appends a row to that
 * entity's activity timeline.
 */

const router = Router();

const TASK_LIST_CONFIG: ListQueryConfig = {
  sortable: ['created_at', 'updated_at', 'due_at', 'priority', 'status', 'title'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  filterable: ['status', 'priority', 'assigned_to', 'branch_id', 'related_type', 'related_id'],
  searchable: ['title', 'description'],
  maxLimit: 100,
  defaultLimit: 25,
};

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

function parseDueAt(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** camelCase body -> snake_case writable subset (allow-listed keys only). */
function pickWritable(body: any): Partial<TaskWritable> {
  const out: Partial<TaskWritable> = {};
  const map: Record<string, keyof TaskWritable> = {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    dueAt: 'due_at',
    due_at: 'due_at',
    relatedType: 'related_type',
    related_type: 'related_type',
    relatedId: 'related_id',
    related_id: 'related_id',
    branchId: 'branch_id',
    branch_id: 'branch_id',
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

async function resolveTaskScope(client: PoolClient, ctx: PgTenantContext): Promise<TaskScope> {
  const { rows } = await client.query(
    `SELECT branch_id FROM user_branches WHERE shop_id = $1 AND user_id = $2`,
    [ctx.shopId, ctx.user.id],
  );
  const branchIds = rows.map((r) => r.branch_id as string);
  return {
    userId: ctx.user.id,
    branchIds: branchIds.length ? branchIds : null,
    ownOnly: ctx.crmRole === 'dealer',
  };
}

function branchInScope(scope: TaskScope, branchId: string | null | undefined): boolean {
  if (!scope.branchIds) return true;
  if (!branchId) return false;
  return scope.branchIds.includes(branchId);
}

/** Validate that a `related_type` / `related_id` pair points at a live row in this shop. */
async function relatedExists(
  client: PoolClient,
  shopId: string,
  type: TaskRelatedType,
  id: string,
): Promise<boolean> {
  if (type === 'lead') return leadBelongsToShop(client, shopId, id);
  if (type === 'opportunity') return opportunityBelongsToShop(client, shopId, id);
  return customerBelongsToShop(client, shopId, id);
}

const serialize = (row: TaskRow) => rowToApi(row);

/* ------------------------------------------------------------------ */
/* GET /api/crm/tasks                                                  */
/* ------------------------------------------------------------------ */
router.get('/', ...requireCrmPermission('task', 'view'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const parsed = parseListQuery(req.query as Record<string, unknown>, TASK_LIST_CONFIG);
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const overdue = req.query.overdue === '1' || req.query.overdue === 'true';
  try {
    const { rows, total } = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      return listTasks(client, { shopId: ctx.shopId, scope, parsed, mine, overdue });
    });
    res.json({
      data: rowsToApi(rows),
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
    });
  } catch (err: any) {
    console.error('[GET /api/crm/tasks] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/crm/tasks/:id                                              */
/* ------------------------------------------------------------------ */
router.get('/:id', ...requireCrmPermission('task', 'view'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const task = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      return getTaskById(client, ctx.shopId, req.params.id, { scope });
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(serialize(task));
  } catch (err: any) {
    console.error('[GET /api/crm/tasks/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/tasks                                                 */
/* ------------------------------------------------------------------ */
router.post('/', ...requireCrmPermission('task', 'create'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
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
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);

      const branchId: string | null = data.branch_id ?? null;
      if (branchId && !(await branchBelongsToShop(client, ctx.shopId, branchId))) {
        return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
      }
      if (!branchInScope(scope, branchId)) {
        return { err: { status: 403, msg: 'You can only create tasks within your assigned branch(es)' } };
      }
      if (relType && relId && !(await relatedExists(client, ctx.shopId, relType as TaskRelatedType, String(relId)))) {
        return { err: { status: 400, msg: `related ${relType} does not belong to this shop` } };
      }

      let assignedTo: string | null = null;
      if (assignedToRaw) {
        if (!(await userBelongsToShop(client, ctx.shopId, String(assignedToRaw)))) {
          return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
        }
        assignedTo = String(assignedToRaw);
      }
      if (ctx.crmRole === 'dealer') assignedTo = ctx.user.id;

      const task = await insertTask(client, {
        shopId: ctx.shopId,
        createdBy: ctx.user.id,
        data: { ...data, branch_id: branchId, assigned_to: assignedTo },
      });

      if (task.related_type && task.related_id) {
        await recordActivity(client, {
          shopId: ctx.shopId,
          branchId,
          entityType: task.related_type,
          entityId: task.related_id,
          type: 'system',
          body: `Task created: ${task.title}`,
          data: { taskId: task.id },
          actorUserId: ctx.user.id,
        });
      }
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId,
          actorUserId: ctx.user.id,
          entityType: 'task',
          entityId: task.id,
          action: 'create',
          after: task,
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'task.created',
          payload: { taskId: task.id, assignedTo },
          dedupeKey: `task.created:${task.id}`,
        },
        client,
      );
      return { task };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.status(201).json(serialize(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/crm/tasks] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create task' });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH / PUT /api/crm/tasks/:id                                      */
/* ------------------------------------------------------------------ */
async function handleUpdate(req: Request, res: Response) {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const patch = pickWritable(req.body);
  delete (patch as any).assigned_to; // assignment has its own endpoint/permission

  if ('title' in patch && (!patch.title || String(patch.title).trim().length === 0)) {
    return res.status(400).json({ error: 'title cannot be empty' });
  }
  if (patch.status && !TASK_OPEN_STATUSES.includes(patch.status as any)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_OPEN_STATUSES.join(', ')} (use /complete to finish)` });
  }
  if (patch.priority && !TASK_PRIORITIES.includes(patch.priority as any)) {
    return res.status(400).json({ error: `priority must be one of: ${TASK_PRIORITIES.join(', ')}` });
  }
  if (('related_type' in patch || 'related_id' in patch)) {
    const relType = 'related_type' in patch ? patch.related_type ?? null : undefined;
    const relId = 'related_id' in patch ? patch.related_id ?? null : undefined;
    // When either is being changed, both must end up set together or both null.
    if (relType !== undefined && relId !== undefined && (relType == null) !== (relId == null)) {
      return res.status(400).json({ error: 'relatedType and relatedId must be provided together' });
    }
  }

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      const before = await getTaskById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if (before.status === 'completed') {
        return { err: { status: 409, msg: 'A completed task cannot be edited' } };
      }

      if ('branch_id' in patch && patch.branch_id) {
        if (!(await branchBelongsToShop(client, ctx.shopId, patch.branch_id))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        if (!branchInScope(scope, patch.branch_id)) {
          return { err: { status: 403, msg: 'That branch is outside your scope' } };
        }
      }

      const nextRelType = ('related_type' in patch ? patch.related_type ?? null : before.related_type) as
        | TaskRelatedType
        | null;
      const nextRelId = ('related_id' in patch ? patch.related_id ?? null : before.related_id) as string | null;
      if ((nextRelType == null) !== (nextRelId == null)) {
        return { err: { status: 400, msg: 'relatedType and relatedId must be provided together' } };
      }
      if (
        nextRelType &&
        nextRelId &&
        (nextRelType !== before.related_type || nextRelId !== before.related_id) &&
        !(await relatedExists(client, ctx.shopId, nextRelType, nextRelId))
      ) {
        return { err: { status: 400, msg: `related ${nextRelType} does not belong to this shop` } };
      }

      const updated = await updateTask(client, ctx.shopId, req.params.id, {
        ...patch,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'task',
          entityId: updated.id,
          action: 'update',
          before,
          after: updated,
        },
        client,
      );
      return { task: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.task));
  } catch (err: any) {
    console.error('[PATCH /api/crm/tasks/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update task' });
  }
}
router.patch('/:id', ...requireCrmPermission('task', 'update'), handleUpdate);
router.put('/:id', ...requireCrmPermission('task', 'update'), handleUpdate);

/* ------------------------------------------------------------------ */
/* POST /api/crm/tasks/:id/assign                                      */
/* ------------------------------------------------------------------ */
router.post('/:id/assign', ...requireCrmPermission('task', 'assign'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const assignedTo = req.body?.assignedTo ?? req.body?.assigned_to;
  const branchIdRaw = req.body?.branchId ?? req.body?.branch_id;
  if (!assignedTo) return res.status(400).json({ error: 'assignedTo is required' });

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      const before = await getTaskById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if (before.status === 'completed') {
        return { err: { status: 409, msg: 'A completed task cannot be reassigned' } };
      }

      if (!(await userBelongsToShop(client, ctx.shopId, String(assignedTo)))) {
        return { err: { status: 400, msg: 'assignedTo is not an active user of this shop' } };
      }
      let branchId = before.branch_id;
      if (branchIdRaw) {
        if (!(await branchBelongsToShop(client, ctx.shopId, String(branchIdRaw)))) {
          return { err: { status: 400, msg: 'branch_id does not belong to this shop' } };
        }
        if (!branchInScope(scope, String(branchIdRaw))) {
          return { err: { status: 403, msg: 'That branch is outside your scope' } };
        }
        branchId = String(branchIdRaw);
      }

      const updated = await updateTask(client, ctx.shopId, req.params.id, {
        assigned_to: String(assignedTo),
        branch_id: branchId,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId,
          actorUserId: ctx.user.id,
          entityType: 'task',
          entityId: updated.id,
          action: 'assign',
          before: { assigned_to: before.assigned_to },
          after: { assigned_to: updated.assigned_to },
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'task.assigned',
          payload: { taskId: updated.id, assignedTo: String(assignedTo), assignedBy: ctx.user.id },
          dedupeKey: `task.assigned:${updated.id}:${assignedTo}`,
        },
        client,
      );
      return { task: updated };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/crm/tasks/:id/assign] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to assign task' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/crm/tasks/:id/complete                                    */
/* ------------------------------------------------------------------ */
router.post('/:id/complete', ...requireCrmPermission('task', 'complete'), async (req: Request, res: Response) => {
  if (!guardShopScope(req, res)) return;
  const ctx = req.pgTenant!;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      const before = await getTaskById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };
      if (before.status === 'completed') {
        return { ok: true, task: before, already: true };
      }

      const updated = await updateTask(client, ctx.shopId, req.params.id, {
        status: 'completed',
        completed_at: new Date(),
        completed_by: ctx.user.id,
        last_activity_at: new Date(),
      });
      if (!updated) return { err: { status: 404, msg: 'Task not found' } };

      if (updated.related_type && updated.related_id) {
        await recordActivity(client, {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          entityType: updated.related_type,
          entityId: updated.related_id,
          type: 'completion',
          body: `Task completed: ${updated.title}${note ? ` — ${note}` : ''}`,
          data: { taskId: updated.id },
          actorUserId: ctx.user.id,
        });
      }
      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: updated.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'task',
          entityId: updated.id,
          action: 'complete',
          before: { status: before.status },
          after: { status: 'completed' },
          metadata: { note: note || null },
        },
        client,
      );
      await enqueueOutbox(
        {
          shopId: ctx.shopId,
          eventType: 'task.completed',
          payload: { taskId: updated.id, createdBy: updated.created_by, completedBy: ctx.user.id },
          dedupeKey: `task.completed:${updated.id}`,
        },
        client,
      );
      return { ok: true, task: updated, already: false };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json(serialize(outcome.task));
  } catch (err: any) {
    console.error('[POST /api/crm/tasks/:id/complete] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to complete task' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /api/crm/tasks/:id   (soft delete)                           */
/* ------------------------------------------------------------------ */
router.delete('/:id', ...requireCrmPermission('task', 'delete'), async (req: Request, res: Response) => {
  const ctx = req.pgTenant!;
  try {
    const outcome = await withTenant(ctx.shopId, async (client) => {
      const scope = await resolveTaskScope(client, ctx);
      const before = await getTaskById(client, ctx.shopId, req.params.id, { scope, forUpdate: true });
      if (!before) return { err: { status: 404, msg: 'Task not found' } };

      const ok = await softDeleteTask(client, ctx.shopId, req.params.id);
      if (!ok) return { err: { status: 404, msg: 'Task not found' } };

      await recordAudit(
        {
          shopId: ctx.shopId,
          branchId: before.branch_id,
          actorUserId: ctx.user.id,
          entityType: 'task',
          entityId: before.id,
          action: 'delete',
          before,
        },
        client,
      );
      return { ok: true };
    });

    if ('err' in outcome && outcome.err) return res.status(outcome.err.status).json({ error: outcome.err.msg });
    res.json({ message: 'Task deleted' });
  } catch (err: any) {
    console.error('[DELETE /api/crm/tasks/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

export default router;
