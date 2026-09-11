import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestBranch,
  createTestOpportunity,
  createTestTask,
  dropTestShop,
  asShop,
  asWorker,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_SECRET = !!process.env.JWT_TENANT_SECRET;

/**
 * DB-backed route tests for /api/crm/tasks. Mirrors leads.routes.test.ts.
 */
describe.skipIf(!RUN_DB || !HAVE_SECRET)('CRM /tasks routes', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let salesA: string; // sales_exec — has task.view/create/update/complete
  let demoA: string; // demo_exec — has task.* incl. assign
  let accountingA: string; // accounting — NO task perms
  let ownerB: string;

  const tok = (uid: string, shopId: string, role: 'owner' | 'operator' | 'karigar' = 'operator') =>
    signTenantToken({ sub: uid, shopId, username: uid, role });

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken } = await import('../../utils/jwt'));
    srv = await startCrmServer();

    A = await createTestShop(pg, 'taskA');
    B = await createTestShop(pg, 'taskB');
    ownerA = await createTestUser(pg, A, { role: 'owner', crmRole: 'crm_admin' });
    salesA = await createTestUser(pg, A, { role: 'operator', crmRole: 'sales_exec' });
    demoA = await createTestUser(pg, A, { role: 'operator', crmRole: 'demo_exec' });
    accountingA = await createTestUser(pg, A, { role: 'operator', crmRole: 'accounting' });
    ownerB = await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });
  });

  afterAll(async () => {
    await srv?.close();
    if (A) await dropTestShop(pg, A);
    if (B) await dropTestShop(pg, B);
  });

  it('sales_exec can create; accounting (no task.create) 403; no token 401', async () => {
    const ok = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', {
      title: 'Call customer', priority: 'high',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.title).toBe('Call customer');
    expect(ok.body.status).toBe('open');
    expect(ok.body.priority).toBe('high');

    const denied = await api(srv.base, tok(accountingA, A), 'POST', '/api/crm/tasks', { title: 'Nope' });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toMatch(/task\.create/);

    expect((await api(srv.base, null, 'GET', '/api/crm/tasks')).status).toBe(401);
  });

  it('task.assign is an admin action: sales_exec / demo_exec get 403, owner can assign', async () => {
    const task = await createTestTask(pg, A, { title: 'assign me' });
    // No stock CRM role carries task.assign — only crm_admin / owner (implicit '*').
    expect((await api(srv.base, tok(salesA, A), 'POST', `/api/crm/tasks/${task}/assign`, { assignedTo: salesA })).status).toBe(403);
    expect((await api(srv.base, tok(demoA, A), 'POST', `/api/crm/tasks/${task}/assign`, { assignedTo: demoA })).status).toBe(403);

    const ok = await api(srv.base, tok(ownerA, A, 'owner'), 'POST', `/api/crm/tasks/${task}/assign`, { assignedTo: salesA });
    expect(ok.status).toBe(200);
    expect(ok.body.assignedTo).toBe(salesA);

    const evs = await asWorker((c) =>
      c.query(`SELECT event_type FROM crm_outbox WHERE (payload->>'taskId') = $1`, [task]),
    );
    expect(evs.rows.map((r: any) => r.event_type)).toContain('task.assigned');
  });

  it('tenant A cannot see / touch tenant B tasks', async () => {
    const bTask = await createTestTask(pg, B, { title: 'B-secret' });
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'GET', `/api/crm/tasks/${bTask}`)).status).toBe(404);
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'POST', `/api/crm/tasks/${bTask}/complete`)).status).toBe(404);
    const still = await asShop(B, (c) => c.query(`SELECT status FROM crm_task WHERE id = $1`, [bTask]));
    expect(still.rows[0].status).toBe('open');
  });

  it('complete sets status + completed_by, is idempotent, and appends an activity to the related entity', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'linked' });
    const task = await createTestTask(pg, A, {
      title: 'Follow up on opp', assignedTo: salesA, relatedType: 'opportunity', relatedId: opp,
    });

    const done = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/tasks/${task}/complete`, { note: 'done deal' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.completedBy).toBe(salesA);
    expect(done.body.completedAt).toBeTruthy();

    // idempotent
    const again = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/tasks/${task}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('completed');

    const acts = await asShop(A, (c) =>
      c.query(`SELECT type, body FROM crm_activity WHERE entity_type='opportunity' AND entity_id=$1 AND type='completion'`, [opp]),
    );
    expect(acts.rows).toHaveLength(1);
    expect(acts.rows[0].body).toMatch(/Task completed/);

    const evs = await asWorker((c) =>
      c.query(`SELECT event_type FROM crm_outbox WHERE (payload->>'taskId') = $1 AND event_type='task.completed'`, [task]),
    );
    expect(evs.rows).toHaveLength(1);
  });

  it('completed task cannot be edited or reassigned', async () => {
    const task = await createTestTask(pg, A, { title: 'freeze', status: 'completed' });
    // seed completed_at directly (helper inserts status only)
    await asShop(A, (c) => c.query(`UPDATE crm_task SET completed_at = now() WHERE id = $1`, [task]));
    expect((await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/tasks/${task}`, { title: 'x' })).status).toBe(409);
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'POST', `/api/crm/tasks/${task}/assign`, { assignedTo: salesA })).status).toBe(409);
  });

  it('mine + overdue filters', async () => {
    const s = await createTestShop(pg, 'taskFilter');
    const owner = await createTestUser(pg, s, { role: 'owner', crmRole: 'crm_admin' });
    const other = await createTestUser(pg, s, { role: 'operator', crmRole: 'sales_exec' });
    const t = tok(owner, s, 'owner');

    const mineOverdue = await createTestTask(pg, s, {
      title: 'mine-overdue', assignedTo: owner, dueAt: new Date(Date.now() - 86400000),
    });
    await createTestTask(pg, s, { title: 'mine-future', assignedTo: owner, dueAt: new Date(Date.now() + 86400000) });
    await createTestTask(pg, s, { title: 'other-overdue', assignedTo: other, dueAt: new Date(Date.now() - 86400000) });

    const mine = await api(srv.base, t, 'GET', '/api/crm/tasks?mine=1&limit=100');
    expect(mine.body.data.every((x: any) => x.assignedTo === owner)).toBe(true);
    expect(mine.body.data.length).toBe(2);

    const overdue = await api(srv.base, t, 'GET', '/api/crm/tasks?mine=1&overdue=1&limit=100');
    expect(overdue.body.data.map((x: any) => x.id)).toEqual([mineOverdue]);

    await dropTestShop(pg, s);
  });

  it('related pair must be complete; cross-shop related id refused', async () => {
    const half = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', { title: 'x', relatedType: 'lead' });
    expect(half.status).toBe(400);

    const bOpp = await createTestOpportunity(pg, B, { title: 'B opp' });
    const cross = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', {
      title: 'x', relatedType: 'opportunity', relatedId: bOpp,
    });
    expect(cross.status).toBe(400);
  });

  it('client-supplied shop_id rejected', async () => {
    const r = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', { title: 'x', shop_id: B });
    expect(r.status).toBe(400);
  });

  /* ---------------- update / delete / status ---------------- */

  it('PATCH updates open fields and writes an audit row', async () => {
    const task = await createTestTask(pg, A, { title: 'PatchTask', priority: 'low' });
    const r = await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/tasks/${task}`, {
      title: 'Patched task', priority: 'urgent', description: 'now urgent',
    });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Patched task');
    expect(r.body.priority).toBe('urgent');
    expect(r.body.description).toBe('now urgent');

    const aud = await asShop(A, (c) =>
      c.query(`SELECT action FROM crm_audit_log WHERE entity_type='task' AND entity_id=$1`, [task]),
    );
    expect(aud.rows.map((x: any) => x.action)).toContain('update');
  });

  it('status "cancelled" is directly settable (create + patch); "completed" is not', async () => {
    const created = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', { title: 'to cancel', status: 'cancelled' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('cancelled');

    const t2 = await createTestTask(pg, A, { title: 'patch to cancel' });
    const patched = await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/tasks/${t2}`, { status: 'cancelled' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('cancelled');

    const bad = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/tasks', { title: 'x', status: 'completed' });
    expect(bad.status).toBe(400);
  });

  it('DELETE soft-deletes a task: gone from list + GET, deleted_at stamped, audit row written', async () => {
    const task = await createTestTask(pg, A, { title: 'DeleteTask' });
    const del = await api(srv.base, tok(ownerA, A, 'owner'), 'DELETE', `/api/crm/tasks/${task}`);
    expect(del.status).toBe(200);
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'GET', `/api/crm/tasks/${task}`)).status).toBe(404);

    const row = await asShop(A, (c) => c.query(`SELECT deleted_at FROM crm_task WHERE id=$1`, [task]));
    expect(row.rows[0].deleted_at).not.toBeNull();

    const aud = await asShop(A, (c) =>
      c.query(`SELECT action FROM crm_audit_log WHERE entity_type='task' AND entity_id=$1`, [task]),
    );
    expect(aud.rows.map((x: any) => x.action)).toContain('delete');
  });
});
