import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestLead,
  createTestOpportunity,
  createTestTask,
  dropTestShop,
  asShop,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_TENANT_SECRET = !!process.env.JWT_TENANT_SECRET;
const HAVE_SUPERADMIN_SECRET = !!(process.env.JWT_SECRET || process.env.JWT_SUPERADMIN_SECRET);

/**
 * DB-backed tests for the Super Admin CRM route layer
 * (/api/superadmin/crm/*, src/crm/routes/admin/*.ts).
 *
 * Covers: cross-shop reads see every shop; a tenant token is always
 * rejected; single-shop drilldown is isolated by shopId; a write lands with
 * the correct shop_id and is invisible from another shop's RLS context.
 */
describe.skipIf(!RUN_DB || !HAVE_TENANT_SECRET || !HAVE_SUPERADMIN_SECRET)('Super Admin CRM routes', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;
  let signSuperAdminToken: typeof import('../../utils/jwt').signSuperAdminToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let ownerB: string;
  let leadA: string;
  let leadB: string;
  let oppA: string;
  let taskA: string;
  let saToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken, signSuperAdminToken } = await import('../../utils/jwt'));

    A = await createTestShop(pg, 'sa_admin_a');
    B = await createTestShop(pg, 'sa_admin_b');
    ownerA = await createTestUser(pg, A, { role: 'owner', crmRole: 'crm_admin' });
    ownerB = await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });

    leadA = await createTestLead(pg, A, { name: 'Lead A1' });
    leadB = await createTestLead(pg, B, { name: 'Lead B1' });
    oppA = await createTestOpportunity(pg, A, { title: 'Opp A1', amount: 5000 });
    taskA = await createTestTask(pg, A, { title: 'Task A1' });

    saToken = signSuperAdminToken({ sub: 'superadmin_test_id', username: 'superadmin_test' });
    tenantToken = signTenantToken({ sub: ownerA, shopId: A, username: ownerA, role: 'owner' });

    srv = await startCrmServer();
  });

  afterAll(async () => {
    await srv?.close();
    await dropTestShop(pg, A);
    await dropTestShop(pg, B);
  });

  it('tenant token is rejected on every /api/superadmin/crm/* route', async () => {
    const r1 = await api(srv.base, tenantToken, 'GET', '/api/superadmin/crm/leads');
    expect([401, 403]).toContain(r1.status);
    const r2 = await api(srv.base, tenantToken, 'GET', '/api/superadmin/crm/dashboard');
    expect([401, 403]).toContain(r2.status);
    const r3 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/leads/${A}/${leadA}`);
    expect([401, 403]).toContain(r3.status);
    const r4 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/leads/${A}/${leadA}/activities`);
    expect([401, 403]).toContain(r4.status);
    const r5 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/users/${A}`);
    expect([401, 403]).toContain(r5.status);
    const r6 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/opportunities/${A}/${oppA}/activities`);
    expect([401, 403]).toContain(r6.status);
    const r7 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/opportunities/${A}/${oppA}`);
    expect([401, 403]).toContain(r7.status);
    const r8 = await api(srv.base, tenantToken, 'GET', `/api/superadmin/crm/tasks/${A}/${taskA}`);
    expect([401, 403]).toContain(r8.status);
  });

  it('no token is rejected', async () => {
    const r = await api(srv.base, null, 'GET', '/api/superadmin/crm/leads');
    expect(r.status).toBe(401);
  });

  it('GET /shops lists every shop', async () => {
    const r = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/shops');
    expect(r.status).toBe(200);
    const ids = r.body.map((s: any) => s.id);
    expect(ids).toContain(A);
    expect(ids).toContain(B);
  });

  it('GET /leads is cross-shop — sees rows from every shop', async () => {
    const r = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/leads?limit=100');
    expect(r.status).toBe(200);
    const names = r.body.data.map((l: any) => l.name);
    expect(names).toContain('Lead A1');
    expect(names).toContain('Lead B1');
    // shop name join is present
    const rowA = r.body.data.find((l: any) => l.id === leadA);
    expect(rowA.shopName).toBeTruthy();
  });

  it('GET /leads/:shopId/:id — correct shop 200s, wrong shop 404s', async () => {
    const ok = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/leads/${A}/${leadA}`);
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Lead A1');

    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/leads/${B}/${leadA}`);
    expect(wrongShop.status).toBe(404);
  });

  it('POST /leads/:shopId creates a lead scoped to that shop only', async () => {
    const created = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${A}`, { name: 'SA Created Lead' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('SA Created Lead');
    const newId = created.body.id;

    const visibleInA = await asShop(A, (c) => c.query(`SELECT id FROM crm_lead WHERE id = $1`, [newId]));
    expect(visibleInA.rows.length).toBe(1);

    const visibleInB = await asShop(B, (c) => c.query(`SELECT id FROM crm_lead WHERE id = $1`, [newId]));
    expect(visibleInB.rows.length).toBe(0);

    // audit row recorded with no FK-violating actor_user_id, actor identity in metadata
    const audit = await asShop(A, (c) =>
      c.query(`SELECT actor_user_id, metadata FROM crm_audit_log WHERE entity_id = $1 AND action = 'create'`, [newId]),
    );
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].metadata.actorSuperAdminId).toBe('superadmin_test_id');
  });

  it('PATCH /leads/:shopId/:id updates within the shop', async () => {
    const r = await api(srv.base, saToken, 'PATCH', `/api/superadmin/crm/leads/${A}/${leadA}`, { notes: 'updated by SA' });
    expect(r.status).toBe(200);
    expect(r.body.notes).toBe('updated by SA');
  });

  it('POST /leads/:shopId/:id/qualify reuses the Phase 3 service', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${A}/${leadA}/qualify`, { outcome: 'qualified', score: 80 });
    expect(r.status).toBe(200);
    expect(r.body.qualificationStatus).toBe('qualified');
  });

  it('GET /opportunities is cross-shop and GET /opportunities/pipeline aggregates across shops', async () => {
    const list = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/opportunities?limit=100');
    expect(list.status).toBe(200);
    expect(list.body.data.some((o: any) => o.id === oppA)).toBe(true);

    const pipeline = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/opportunities/pipeline');
    expect(pipeline.status).toBe(200);
    expect(Array.isArray(pipeline.body.stages)).toBe(true);
  });

  it('POST /opportunities/:shopId/:id/stage changes stage within the shop', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppA}/stage`, { stage: 'proposal' });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('proposal');
  });

  it('GET /tasks is cross-shop and POST /tasks/:shopId/:id/complete completes within the shop', async () => {
    const list = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/tasks?limit=100');
    expect(list.status).toBe(200);
    expect(list.body.data.some((t: any) => t.id === taskA)).toBe(true);

    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${A}/${taskA}/complete`, {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
  });

  it('GET /dashboard aggregates across shops', async () => {
    const r = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.leads.total).toBeGreaterThanOrEqual(3); // leadA, leadB, SA-created lead
    const shopA = r.body.byShop.find((s: any) => s.shopId === A);
    expect(shopA).toBeTruthy();
    expect(shopA.leadCount).toBeGreaterThanOrEqual(2);
  });

  /* ------------------------------------------------------------------ */
  /* Slice 2 — lead activities/timeline + assignee picker                */
  /* ------------------------------------------------------------------ */

  it('GET /leads/:shopId/:id/activities starts empty for a fresh lead, POST adds a note visible on GET', async () => {
    // a fresh lead (not leadA, which earlier tests in this file already touched) so the
    // "starts empty" assertion isn't order-dependent on what ran before it
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${A}`, { name: 'Activity Test Lead' });
    expect(fresh.status).toBe(201);
    const freshLeadId = fresh.body.id;

    const empty = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/leads/${A}/${freshLeadId}/activities`);
    expect(empty.status).toBe(200);
    // the create itself writes one 'system' activity ("Lead created by Super Admin")
    expect(empty.body.total).toBe(1);

    const added = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${A}/${freshLeadId}/activities`, { body: 'Called the customer', type: 'call' });
    expect(added.status).toBe(201);
    expect(added.body.type).toBe('call');
    expect(added.body.body).toContain('Called the customer');

    const after = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/leads/${A}/${freshLeadId}/activities`);
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(2);
    expect(after.body.data[0].id).toBe(added.body.id);

    // actor identity: NOT the FK'd actor_user_id (superadmin id isn't a users.id), recorded in `data` instead
    const raw = await asShop(A, (c) => c.query(`SELECT actor_user_id, data FROM crm_activity WHERE id = $1`, [added.body.id]));
    expect(raw.rows[0].actor_user_id).toBeNull();
    expect(raw.rows[0].data.actorSuperAdminId).toBe('superadmin_test_id');
  });

  it('activities is scoped by :shopId — a lead\'s activities are not reachable via the wrong shop (IDOR check)', async () => {
    const wrongShopGet = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/leads/${B}/${leadA}/activities`);
    expect(wrongShopGet.status).toBe(404);

    const wrongShopPost = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${B}/${leadA}/activities`, { body: 'should not land' });
    expect(wrongShopPost.status).toBe(404);
  });

  it('GET /users/:shopId returns only that shop\'s active users', async () => {
    const usersA = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/users/${A}`);
    expect(usersA.status).toBe(200);
    const idsA = usersA.body.map((u: any) => u.id);
    expect(idsA).toContain(ownerA);
    expect(idsA).not.toContain(ownerB);

    const usersB = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/users/${B}`);
    expect(usersB.status).toBe(200);
    const idsB = usersB.body.map((u: any) => u.id);
    expect(idsB).toContain(ownerB);
    expect(idsB).not.toContain(ownerA);
  });

  it('assign uses the picked shop\'s users only — assigning a lead in A to a user that only exists in B is rejected', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/leads/${A}/${leadA}/assign`, { assignedTo: ownerB });
    expect(r.status).toBe(400);
  });

  it('follow-up tasks: a task created with related_type=lead is visible via the cross-shop task list filtered by related_id', async () => {
    const created = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${A}`, {
      title: 'Follow up with Lead A1', relatedType: 'lead', relatedId: leadA,
    });
    expect(created.status).toBe(201);

    const filtered = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/tasks?related_type=lead&related_id=${leadA}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.some((t: any) => t.id === created.body.id)).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* Slice 3 — opportunity detail/activities, task detail/edit           */
  /* ------------------------------------------------------------------ */

  it('GET /opportunities/:shopId/:id/activities starts with the create system activity, POST adds a note', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}`, { title: 'Activity Test Opp' });
    expect(fresh.status).toBe(201);
    const freshOppId = fresh.body.id;

    const empty = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/opportunities/${A}/${freshOppId}/activities`);
    expect(empty.status).toBe(200);
    expect(empty.body.total).toBe(1); // "Opportunity created by Super Admin"

    const added = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${freshOppId}/activities`, { body: 'Sent proposal', type: 'email' });
    expect(added.status).toBe(201);
    expect(added.body.type).toBe('email');

    const after = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/opportunities/${A}/${freshOppId}/activities`);
    expect(after.body.total).toBe(2);

    const raw = await asShop(A, (c) => c.query(`SELECT actor_user_id, data FROM crm_activity WHERE id = $1`, [added.body.id]));
    expect(raw.rows[0].actor_user_id).toBeNull();
    expect(raw.rows[0].data.actorSuperAdminId).toBe('superadmin_test_id');
  });

  it('opportunity activities is scoped by :shopId — IDOR check', async () => {
    const wrongShopGet = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/opportunities/${B}/${oppA}/activities`);
    expect(wrongShopGet.status).toBe(404);
    const wrongShopPost = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${B}/${oppA}/activities`, { body: 'nope' });
    expect(wrongShopPost.status).toBe(404);
  });

  it('opportunity win: marks won, sets wonAt, rejects a second close', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}`, { title: 'Win Test Opp', amount: 1000 });
    const oppId = fresh.body.id;

    const win = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppId}/win`, { amount: 1500 });
    expect(win.status).toBe(200);
    expect(win.body.stage).toBe('won');
    expect(win.body.amount).toBe(1500);
    expect(win.body.wonAt).toBeTruthy();

    const again = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppId}/win`, {});
    expect(again.status).toBe(409);

    const stageAfterClose = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppId}/stage`, { stage: 'proposal' });
    expect(stageAfterClose.status).toBe(409);
  });

  it('opportunity lose: marks lost with a reason', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}`, { title: 'Lose Test Opp' });
    const oppId = fresh.body.id;

    const lose = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppId}/lose`, { reason: 'Budget cut' });
    expect(lose.status).toBe(200);
    expect(lose.body.stage).toBe('lost');
    expect(lose.body.lostReason).toBe('Budget cut');
  });

  it('opportunity assign is rejected for a user outside the target shop', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/opportunities/${A}/${oppA}/assign`, { assignedTo: ownerB });
    expect(r.status).toBe(400);
  });

  it('opportunity detail wrong shopId is not accessible (IDOR check)', async () => {
    const r = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/opportunities/${B}/${oppA}`);
    expect(r.status).toBe(404);
  });

  it('task detail: GET reuses the existing tenant-shaped repository row, PATCH updates within the shop', async () => {
    const get = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/tasks/${A}/${taskA}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(taskA);

    const patch = await api(srv.base, saToken, 'PATCH', `/api/superadmin/crm/tasks/${A}/${taskA}`, { title: 'Renamed via Super Admin', priority: 'urgent' });
    expect(patch.status).toBe(200);
    expect(patch.body.title).toBe('Renamed via Super Admin');
    expect(patch.body.priority).toBe('urgent');
  });

  it('task detail wrong shopId is not accessible (IDOR check)', async () => {
    const r = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/tasks/${B}/${taskA}`);
    expect(r.status).toBe(404);
  });

  it('task assign is rejected for a user outside the target shop', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${A}`, { title: 'Assign Test Task' });
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${A}/${fresh.body.id}/assign`, { assignedTo: ownerB });
    expect(r.status).toBe(400);
  });

  it('task completion is idempotent-safe against a wrong shop (IDOR check on the action route)', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${B}/${taskA}/complete`, {});
    expect(r.status).toBe(404);
  });
});
