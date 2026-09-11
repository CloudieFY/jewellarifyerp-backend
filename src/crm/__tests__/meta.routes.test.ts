import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestBranch,
  createTestLead,
  createTestOpportunity,
  createTestTask,
  dropTestShop,
  asShop,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_SECRET = !!process.env.JWT_TENANT_SECRET;

/**
 * DB-backed tests for the CRM meta endpoints added for the frontend:
 *   GET /api/crm/dashboard   (report.view rollups + recent activity)
 *   GET /api/crm/users       (any CRM access)
 *   GET /api/crm/branches    (branch.view)
 * plus the customer-scoped lead list filters used by Customer 360.
 */
describe.skipIf(!RUN_DB || !HAVE_SECRET)('CRM meta routes (dashboard / users / branches)', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let accountingA: string; // has report.view + branch.view, no lead.*
  let demoA: string; // demo_exec: NO report.view
  let custA: string;

  const tok = (uid: string, shopId: string, role: 'owner' | 'operator' | 'karigar' = 'operator') =>
    signTenantToken({ sub: uid, shopId, username: uid, role });

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken } = await import('../../utils/jwt'));
    srv = await startCrmServer();

    A = await createTestShop(pg, 'metaA');
    B = await createTestShop(pg, 'metaB');
    ownerA = await createTestUser(pg, A, { role: 'owner', crmRole: 'crm_admin' });
    accountingA = await createTestUser(pg, A, { role: 'operator', crmRole: 'accounting' });
    demoA = await createTestUser(pg, A, { role: 'operator', crmRole: 'demo_exec' });
    await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });
    await createTestBranch(pg, A, 'Main');

    // A customer in shop A + a converted lead pointing at it.
    custA = 'cust_metaA_1';
    await asShop(A, (c) =>
      c.query(
        `INSERT INTO customers (id, shop_id, name, address) VALUES ($1,$2,'Meta Cust','')`,
        [custA, A],
      ),
    );
    const convLead = await createTestLead(pg, A, { name: 'Converted One' });
    await asShop(A, (c) =>
      c.query(
        `UPDATE crm_lead SET status='converted', converted_customer_id=$2, converted_at=now() WHERE id=$1`,
        [convLead, custA],
      ),
    );
    await createTestLead(pg, A, { name: 'Fresh Lead' }); // status defaults to 'new'

    await createTestOpportunity(pg, A, { title: 'Deal 1', amount: 1000, stage: 'proposal' });
    await createTestOpportunity(pg, A, { title: 'Deal 2', amount: 4000, stage: 'won' });
    await createTestTask(pg, A, { title: 'Follow up' });
  });

  afterAll(async () => {
    await srv?.close();
    if (A) await dropTestShop(pg, A);
    if (B) await dropTestShop(pg, B);
  });

  it('GET /dashboard: owner 200 with shop-scoped rollups', async () => {
    const res = await api(srv.base, tok(ownerA, A, 'owner'), 'GET', '/api/crm/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(2);
    expect(res.body.leads.new).toBe(1);
    expect(res.body.leads.converted).toBe(1);
    expect(res.body.opportunities.open).toBe(1);
    expect(res.body.opportunities.won).toBe(1);
    expect(res.body.opportunities.openValue).toBe(1000);
    expect(res.body.opportunities.wonValue).toBe(4000);
    expect(res.body.tasks.pending).toBe(1);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it('GET /dashboard: accounting (report.view) 200; demo_exec (no report.view) 403; no token 401', async () => {
    expect((await api(srv.base, tok(accountingA, A), 'GET', '/api/crm/dashboard')).status).toBe(200);
    expect((await api(srv.base, tok(demoA, A), 'GET', '/api/crm/dashboard')).status).toBe(403);
    expect((await api(srv.base, null, 'GET', '/api/crm/dashboard')).status).toBe(401);
  });

  it('GET /dashboard is tenant-scoped: shop B sees zeroes', async () => {
    const ownerB = await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });
    const res = await api(srv.base, tok(ownerB, B, 'owner'), 'GET', '/api/crm/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(0);
    expect(res.body.opportunities.open).toBe(0);
  });

  it('GET /users: any CRM user 200 with the shop roster; karigar (no CRM) 403', async () => {
    const res = await api(srv.base, tok(demoA, A), 'GET', '/api/crm/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: any) => u.id === ownerA)).toBe(true);

    const karigarA = await createTestUser(pg, A, { role: 'karigar' });
    expect((await api(srv.base, tok(karigarA, A, 'karigar'), 'GET', '/api/crm/users')).status).toBe(403);
  });

  it('GET /branches: branch.view holder 200; returns only this shop branches', async () => {
    const res = await api(srv.base, tok(accountingA, A), 'GET', '/api/crm/branches');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Main');
  });

  it('GET /leads?converted_customer_id= filters to that customer only', async () => {
    const all = await api(srv.base, tok(ownerA, A, 'owner'), 'GET', '/api/crm/leads?limit=50');
    expect(all.body.total).toBe(2);

    const scoped = await api(
      srv.base,
      tok(ownerA, A, 'owner'),
      'GET',
      `/api/crm/leads?converted_customer_id=${custA}`,
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.data[0].name).toBe('Converted One');
  });
});
