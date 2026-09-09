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
  dropTestShop,
  asShop,
  asWorker,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_SECRET = !!process.env.JWT_TENANT_SECRET;

/**
 * DB-backed route tests for /api/crm/opportunities. Exercises the real
 * middleware chain + PostgreSQL RLS. Runs only with TEST_DATABASE_URL +
 * JWT_TENANT_SECRET. Mirrors leads.routes.test.ts.
 */
describe.skipIf(!RUN_DB || !HAVE_SECRET)('CRM /opportunities routes', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let salesA: string; // crm_role sales_exec
  let supportA: string; // crm_role support (no opportunity.create)
  let dealerA: string; // crm_role dealer (own-only, no opportunity perms)
  let branchA1: string;
  let branchA2: string;
  let branchUserA: string; // restricted to branchA1
  let ownerB: string;

  const tok = (uid: string, shopId: string, role: 'owner' | 'operator' | 'karigar' = 'operator') =>
    signTenantToken({ sub: uid, shopId, username: uid, role });

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken } = await import('../../utils/jwt'));
    srv = await startCrmServer();

    A = await createTestShop(pg, 'oppA');
    B = await createTestShop(pg, 'oppB');
    ownerA = await createTestUser(pg, A, { role: 'owner' });
    salesA = await createTestUser(pg, A, { role: 'operator', crmRole: 'sales_exec' });
    supportA = await createTestUser(pg, A, { role: 'operator', crmRole: 'support' });
    dealerA = await createTestUser(pg, A, { role: 'operator', crmRole: 'dealer' });
    ownerB = await createTestUser(pg, B, { role: 'owner' });

    branchA1 = await createTestBranch(pg, A, 'A-One');
    branchA2 = await createTestBranch(pg, A, 'A-Two');
    branchUserA = await createTestUser(pg, A, { role: 'operator', crmRole: 'sales_exec' });
    await asShop(A, (c) =>
      c.query(`INSERT INTO user_branches (shop_id, user_id, branch_id) VALUES ($1,$2,$3)`, [A, branchUserA, branchA1]),
    );
  });

  afterAll(async () => {
    await srv?.close();
    if (A) await dropTestShop(pg, A);
    if (B) await dropTestShop(pg, B);
  });

  /* ---------------- auth / permission catalogue ---------------- */

  it('sales_exec can create; support (no opportunity.create) gets 403; no token 401', async () => {
    const ok = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/opportunities', {
      title: 'Diamond set', amount: 250000,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.title).toBe('Diamond set');
    expect(ok.body.stage).toBe('prospecting');
    expect(ok.body.amount).toBe(250000);

    const denied = await api(srv.base, tok(supportA, A), 'POST', '/api/crm/opportunities', { title: 'Nope' });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toMatch(/opportunity\.create/);

    const anon = await api(srv.base, null, 'GET', '/api/crm/opportunities');
    expect(anon.status).toBe(401);
  });

  it('cannot create directly in a closed stage', async () => {
    const r = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/opportunities', { title: 'x', stage: 'won' });
    expect(r.status).toBe(400);
  });

  /* ---------------- tenant isolation ---------------- */

  it('tenant A cannot read / update / delete tenant B opportunities', async () => {
    const bOpp = await createTestOpportunity(pg, B, { title: 'B-secret' });

    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'GET', `/api/crm/opportunities/${bOpp}`)).status).toBe(404);
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'PATCH', `/api/crm/opportunities/${bOpp}`, { title: 'hijack' })).status).toBe(404);
    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'DELETE', `/api/crm/opportunities/${bOpp}`)).status).toBe(404);

    const stillThere = await asShop(B, (c) => c.query(`SELECT title FROM crm_opportunity WHERE id = $1`, [bOpp]));
    expect(stillThere.rows[0].title).toBe('B-secret');
  });

  it('client-supplied shop_id in body is rejected (400)', async () => {
    const r = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/opportunities', { title: 'Injector', shop_id: B });
    expect(r.status).toBe(400);
  });

  it('cross-shop lead / customer references are refused', async () => {
    const bLead = await createTestLead(pg, B, { name: 'B lead' });
    const r = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/opportunities', { title: 'x', leadId: bLead });
    expect(r.status).toBe(400);
  });

  /* ---------------- branch scoping ---------------- */

  it('branch-restricted user only sees their branch and cannot use another branch', async () => {
    const inScope = await createTestOpportunity(pg, A, { title: 'inbranch', branchId: branchA1 });
    const outScope = await createTestOpportunity(pg, A, { title: 'outbranch', branchId: branchA2 });

    const list = await api(srv.base, tok(branchUserA, A), 'GET', '/api/crm/opportunities?limit=100');
    const ids = list.body.data.map((o: any) => o.id);
    expect(ids).toContain(inScope);
    expect(ids).not.toContain(outScope);

    expect((await api(srv.base, tok(branchUserA, A), 'GET', `/api/crm/opportunities/${outScope}`)).status).toBe(404);

    const createOut = await api(srv.base, tok(branchUserA, A), 'POST', '/api/crm/opportunities', {
      title: 'x', branchId: branchA2,
    });
    expect(createOut.status).toBe(403);
  });

  /* ---------------- list query ---------------- */

  it('pagination / filter / sort / search; injection in sort is ignored', async () => {
    const s = await createTestShop(pg, 'oppLq');
    const u = await createTestUser(pg, s, { role: 'owner' });
    const t = tok(u, s, 'owner');
    for (let i = 0; i < 7; i++) {
      await createTestOpportunity(pg, s, {
        title: `LQ ${i}`, stage: i % 2 ? 'qualification' : 'prospecting', amount: 1000 * i,
      });
    }

    const p1 = await api(srv.base, t, 'GET', '/api/crm/opportunities?limit=3&page=1&sort=title&dir=asc');
    expect(p1.body.data).toHaveLength(3);
    expect(p1.body.total).toBe(7);
    expect(p1.body.data[0].title).toBe('LQ 0');

    const filtered = await api(srv.base, t, 'GET', '/api/crm/opportunities?stage=qualification&limit=100');
    expect(filtered.body.data.every((o: any) => o.stage === 'qualification')).toBe(true);
    expect(filtered.body.data.length).toBe(3);

    const evil = await api(srv.base, t, 'GET', "/api/crm/opportunities?sort=title%3BDROP%20TABLE%20crm_opportunity%3B--");
    expect(evil.status).toBe(200);
    const still = await asShop(s, (c) => c.query(`SELECT count(*)::int n FROM crm_opportunity`));
    expect(still.rows[0].n).toBe(7);

    await dropTestShop(pg, s);
  });

  /* ---------------- pipeline summary ---------------- */

  it('GET /pipeline returns per-stage count + amount and an open roll-up', async () => {
    const s = await createTestShop(pg, 'oppPipe');
    const u = await createTestUser(pg, s, { role: 'owner' });
    const t = tok(u, s, 'owner');
    await createTestOpportunity(pg, s, { stage: 'prospecting', amount: 100 });
    await createTestOpportunity(pg, s, { stage: 'prospecting', amount: 50 });
    await createTestOpportunity(pg, s, { stage: 'negotiation', amount: 400 });

    const r = await api(srv.base, t, 'GET', '/api/crm/opportunities/pipeline');
    expect(r.status).toBe(200);
    const prospecting = r.body.stages.find((x: any) => x.stage === 'prospecting');
    expect(prospecting.count).toBe(2);
    expect(Number(prospecting.amount)).toBe(150);
    expect(r.body.open.count).toBe(3);
    expect(Number(r.body.open.amount)).toBe(550);
    expect(r.body.won.count).toBe(0);

    await dropTestShop(pg, s);
  });

  /* ---------------- stage / assign / win / lose ---------------- */

  it('stage change writes activity + outbox; win/lose are terminal', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'Pipeline', amount: 1000 });

    const asg = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/assign`, { assignedTo: salesA });
    expect(asg.status).toBe(200);
    expect(asg.body.assignedTo).toBe(salesA);

    const stage = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/stage`, { stage: 'proposal' });
    expect(stage.status).toBe(200);
    expect(stage.body.stage).toBe('proposal');

    const won = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/win`, { amount: 1500 });
    expect(won.status).toBe(200);
    expect(won.body.stage).toBe('won');
    expect(won.body.amount).toBe(1500);
    expect(won.body.probability).toBe(100);
    expect(won.body.wonAt).toBeTruthy();

    // already closed
    const again = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/lose`, { reason: 'x' });
    expect(again.status).toBe(409);

    const acts = await asShop(A, (c) =>
      c.query(`SELECT type FROM crm_activity WHERE entity_type='opportunity' AND entity_id=$1 ORDER BY created_at`, [opp]),
    );
    const types = acts.rows.map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(['assignment', 'stage_change', 'won']));

    const evs = await asWorker((c) =>
      c.query(`SELECT event_type FROM crm_outbox WHERE (payload->>'opportunityId') = $1`, [opp]),
    );
    const evTypes = evs.rows.map((r: any) => r.event_type);
    expect(evTypes).toEqual(expect.arrayContaining(['opportunity.assigned', 'opportunity.stage_changed', 'opportunity.won']));
  });

  it('PATCH cannot set stage won/lost; must use the endpoints', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'guarded' });
    const r = await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/opportunities/${opp}`, { stage: 'won' });
    expect(r.status).toBe(400);
  });

  it('lose records reason + activity', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'losing' });
    const r = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/lose`, { reason: 'budget cut' });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('lost');
    expect(r.body.lostReason).toBe('budget cut');
    const row = await asShop(A, (c) => c.query(`SELECT lost_at, probability FROM crm_opportunity WHERE id=$1`, [opp]));
    expect(row.rows[0].lost_at).not.toBeNull();
    expect(row.rows[0].probability).toBe(0);
  });

  it('create from a lead links it and drops an activity on the lead', async () => {
    const lead = await createTestLead(pg, A, { name: 'Origin', phone: '900123' });
    const r = await api(srv.base, tok(salesA, A), 'POST', '/api/crm/opportunities', { title: 'From lead', leadId: lead });
    expect(r.status).toBe(201);
    expect(r.body.leadId).toBe(lead);
    const leadActs = await asShop(A, (c) =>
      c.query(`SELECT body FROM crm_activity WHERE entity_type='lead' AND entity_id=$1`, [lead]),
    );
    expect(leadActs.rows.some((x: any) => /Opportunity created/i.test(x.body))).toBe(true);
  });

  /* ---------------- update / delete / activities ---------------- */

  it('PATCH updates open fields and writes an audit + activity row', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'PatchMe', amount: 1000 });
    const r = await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/opportunities/${opp}`, {
      title: 'Patched', amount: 2500, probability: 40, notes: 'warmer now',
    });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Patched');
    expect(r.body.amount).toBe(2500);
    expect(r.body.probability).toBe(40);

    const aud = await asShop(A, (c) =>
      c.query(`SELECT action FROM crm_audit_log WHERE entity_type='opportunity' AND entity_id=$1`, [opp]),
    );
    expect(aud.rows.map((x: any) => x.action)).toContain('update');

    const acts = await asShop(A, (c) =>
      c.query(`SELECT type FROM crm_activity WHERE entity_type='opportunity' AND entity_id=$1`, [opp]),
    );
    expect(acts.rows.map((x: any) => x.type)).toContain('note');
  });

  it('PATCH rejects probability outside 0..100', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'ProbGuard' });
    expect((await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/opportunities/${opp}`, { probability: 150 })).status).toBe(400);
    expect((await api(srv.base, tok(salesA, A), 'PATCH', `/api/crm/opportunities/${opp}`, { probability: -1 })).status).toBe(400);
  });

  it('DELETE soft-deletes: gone from list + GET, deleted_at stamped, audit row written', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'DeleteMe' });
    const del = await api(srv.base, tok(ownerA, A, 'owner'), 'DELETE', `/api/crm/opportunities/${opp}`);
    expect(del.status).toBe(200);

    expect((await api(srv.base, tok(ownerA, A, 'owner'), 'GET', `/api/crm/opportunities/${opp}`)).status).toBe(404);

    const list = await api(srv.base, tok(ownerA, A, 'owner'), 'GET', '/api/crm/opportunities?limit=100');
    expect(list.body.data.map((o: any) => o.id)).not.toContain(opp);

    const row = await asShop(A, (c) => c.query(`SELECT deleted_at FROM crm_opportunity WHERE id=$1`, [opp]));
    expect(row.rows[0].deleted_at).not.toBeNull();

    const aud = await asShop(A, (c) =>
      c.query(`SELECT action FROM crm_audit_log WHERE entity_type='opportunity' AND entity_id=$1`, [opp]),
    );
    expect(aud.rows.map((x: any) => x.action)).toContain('delete');
  });

  it('GET/POST /:id/activities appends and lists timeline entries; unknown id 404s', async () => {
    const opp = await createTestOpportunity(pg, A, { title: 'Timeline' });
    const post = await api(srv.base, tok(salesA, A), 'POST', `/api/crm/opportunities/${opp}/activities`, {
      type: 'call', body: 'Rang the customer',
    });
    expect(post.status).toBe(201);

    const list = await api(srv.base, tok(salesA, A), 'GET', `/api/crm/opportunities/${opp}/activities`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((a: any) => a.body === 'Rang the customer' && a.type === 'call')).toBe(true);

    expect((await api(srv.base, tok(salesA, A), 'GET', '/api/crm/opportunities/nope/activities')).status).toBe(404);
  });
});
