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
});
