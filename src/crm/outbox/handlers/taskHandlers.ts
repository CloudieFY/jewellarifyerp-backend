/**
 * CRM task outbox handlers (Phase 2).
 *
 * Minimal: they write an in-app `crm_notification` row. Every handler runs
 * inside `withTenant(row.shop_id, …)`.
 */

import { withTenant } from '../../../utils/db';
import { registerOutboxHandler, type OutboxHandler } from '../worker';
import type { OutboxRow } from '../repository';
import { notifyUserOnce } from './_notify';

const onTaskCreated: OutboxHandler = async (row: OutboxRow) => {
  const { taskId, assignedTo } = row.payload as { taskId: string; assignedTo?: string | null };
  if (!taskId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'task',
      entityId: taskId,
      type: 'task.created',
      title: 'A task was assigned to you',
    }),
  );
};

const onTaskAssigned: OutboxHandler = async (row: OutboxRow) => {
  const { taskId, assignedTo } = row.payload as { taskId: string; assignedTo?: string | null };
  if (!taskId || !assignedTo) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: assignedTo,
      entityType: 'task',
      entityId: taskId,
      type: 'task.assigned',
      title: 'A task was assigned to you',
    }),
  );
};

const onTaskCompleted: OutboxHandler = async (row: OutboxRow) => {
  const { taskId, createdBy, completedBy } = row.payload as {
    taskId: string;
    createdBy?: string | null;
    completedBy?: string | null;
  };
  if (!taskId || !createdBy || createdBy === completedBy) return;
  await withTenant(row.shop_id, (client) =>
    notifyUserOnce(client, {
      shopId: row.shop_id,
      userId: createdBy,
      entityType: 'task',
      entityId: taskId,
      type: 'task.completed',
      title: 'A task you created was completed',
    }),
  );
};

/** Register the Phase 2 task handlers. Safe to call more than once. */
export function registerTaskOutboxHandlers(): void {
  registerOutboxHandler('task.created', onTaskCreated);
  registerOutboxHandler('task.assigned', onTaskAssigned);
  registerOutboxHandler('task.completed', onTaskCompleted);
}
