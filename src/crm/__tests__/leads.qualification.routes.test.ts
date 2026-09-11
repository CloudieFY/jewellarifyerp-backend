import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestBranch,
  createTestLead,
  createTestCustomer,
  dropTestShop,
  asShop,
  asWorker,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_SECRET = !!process.env.JWT_TENANT_SECRET;

/**
 * DB-backed route tests for Phase 3 — structured lead qualification and
 * lead -> opportunity promotion. Exercises the real middleware chain
 * (requirePgTenantAuth -> requireCrmPermission -> withTenant -> RLS).
 * Runs only with TEST_DATABASE_URL + JWT_TENANT_SECRET. Mirrors
 * opportunities.routes.test.ts.
 */
describe.skipIf(!RUN_DB || !HAVE_SECRET)('CRM Phase 3 — lead qualification + promotion', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let salesA: string; // sales_exec — lead.qualify + opportunity.create
  let supportA: string; // support — NO lead.qualify, NO opportunity.create
  let dealerA: string; // dealer — own-only, NO lead.qualify
  let branchA1: string;
  let branchA2: string;
  let branchUserA: string; // sales_exec restricted to branchA1
  let ownerB: string;

  const tok = (uid: string, shopId: string, role: 'owner' | 'operator' | 'karigar' = 'operator') =>
    signTenantToken({ sub: uid, shopId, username: uid, role });

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken } = await import('../../utils/jwt'));
    srv = await startCrmServer();

    A = await createTestShop(pg, 'qualA');
    B = await createTestShop(pg, 'qualB');
    ownerA = await createTestUser(pg, A, { role: 'owner', crmRole: 'crm_admin' });
    salesA = await createTestUser(pg, A, { role: 'operator', crmRole: 'sales_exec' });
    supportA = await createTestUser(pg, A, { role: 'operator', crmRole: 'support' });
    dealerA = await createTestUser(pg, A, { role: 'operator', crmRole: 'dealer' });
    ownerB = await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });

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

  const qualify = (uid: string, shop: string, leadId: string, body: unknown, role?: 'owner' | 'operator') =>
    api(srv.base, tok(uid, shop, role), 'POST', `/api/crm/leads/${leadId}/qualify`, body);
  const promote = (uid: string, shop: string, leadId: string, body?: unknown, role?: 'owner' | 'operator') =>
    api(srv.base, tok(uid, shop, role), 'POST', `/api/crm/leads/${leadId}/promote`, body ?? {});

  /* ---------------- 1. qualify success + 3. qualified details ---------------- */

  it('sales_exec qualifies a lead: status + qualification_status + qualified_by/at', async () => {
    const lead = await createTestLead(pg, A, { name: 'Qualify me', phone: '900001' });
    const r = await qualify(salesA, A, lead, {
      outcome: 'qualified',
      score: 80,
      notes: 'hot',
      data: { authority: 'decision_maker', need: 'high', timeline: 'immediate', budget: '2L' },
    });
    expect(r.status).toBe(200);
    expect(r.body.qualificationStatus).toBe('qualified');
    expect(r.body.status).toBe('qualified');
    expect(r.body.qualificationScore).toBe(80);
    expect(r.body.qualifiedAt).toBeTruthy();

    const row = await asShop(A, (c) =>
      c.query(`SELECT qualified_by, disqualified_at, qualification_data FROM crm_lead WHERE id = $1`, [lead]),
    );
    expect(row.rows[0].qualified_by).toBe(salesA);
    expect(row.rows[0].disqualified_at).toBeNull();
    expect(row.rows[0].qualification_data).toMatchObject({ authority: 'decision_maker', need: 'high' });
  });

  /* ---------------- 2. validation ---------------- */

  it('rejects invalid qualification input', async () => {
    const lead = await createTestLead(pg, A, { name: 'Bad input' });
    expect((await qualify(salesA, A, lead, { outcome: 'maybe' })).status).toBe(400);
    expect((await qualify(salesA, A, lead, { outcome: 'qualified', score: 150 })).status).toBe(400);
    expect((await qualify(salesA, A, lead, { outcome: 'disqualified' })).status).toBe(400); // reason required
    expect((await qualify(salesA, A, lead, { outcome: 'qualified', data: { junk: 'x' } })).status).toBe(400);
    expect((await qualify(salesA, A, lead, { outcome: 'qualified', data: { need: 'sometimes' } })).status).toBe(400);
    expect((await qualify(salesA, A, lead, { outcome: 'nurture', nurtureUntil: '31-12-2026' })).status).toBe(400);
    // untouched
    const row = await asShop(A, (c) => c.query(`SELECT qualification_status FROM crm_lead WHERE id = $1`, [lead]));
    expect(row.rows[0].qualification_status).toBeNull();
  });

  /* ---------------- 4. nurture outcome ---------------- */

  it('nurture outcome sets qualification_status but leaves status untouched', async () => {
    const lead = await createTestLead(pg, A, { name: 'Nurture me' });
    const before = await asShop(A, (c) => c.query(`SELECT status FROM crm_lead WHERE id = $1`, [lead]));
    const r = await qualify(salesA, A, lead, { outcome: 'nurture', nurtureUntil: '2026-12-01', notes: 'call in Q4' });
    expect(r.status).toBe(200);
    expect(r.body.qualificationStatus).toBe('nurture');
    expect(r.body.status).toBe(before.rows[0].status); // unchanged
    expect(String(r.body.nurtureUntil)).toContain('2026-12-01');
    const row = await asShop(A, (c) => c.query(`SELECT nurture_until FROM crm_lead WHERE id = $1`, [lead]));
    expect(new Date(row.rows[0].nurture_until).toISOString()).toContain('2026-12-01');
  });

  /* ---------------- 5. disqualified outcome ---------------- */

  it('disqualified outcome sets status=unqualified + disqualified_at/reason', async () => {
    const lead = await createTestLead(pg, A, { name: 'Disqualify me' });
    const r = await qualify(salesA, A, lead, { outcome: 'disqualified', reason: 'no budget' });
    expect(r.status).toBe(200);
    expect(r.body.qualificationStatus).toBe('disqualified');
    expect(r.body.status).toBe('unqualified');
    expect(r.body.disqualifiedReason).toBe('no budget');
    const row = await asShop(A, (c) => c.query(`SELECT disqualified_at FROM crm_lead WHERE id = $1`, [lead]));
    expect(row.rows[0].disqualified_at).not.toBeNull();
  });

  /* ---------------- 6. invalid state transition ---------------- */

  it('cannot qualify a converted lead (409)', async () => {
    const lead = await createTestLead(pg, A, { name: 'Converted' });
    await asShop(A, (c) => c.query(`UPDATE crm_lead SET status = 'converted' WHERE id = $1`, [lead]));
    const r = await qualify(salesA, A, lead, { outcome: 'qualified' });
    expect(r.status).toBe(409);
  });

  /* ---------------- 7. unauthorized ---------------- */

  it('qualify: support role 403, dealer 403, no token 401', async () => {
    const lead = await createTestLead(pg, A, { name: 'Auth' });
    expect((await qualify(supportA, A, lead, { outcome: 'qualified' })).status).toBe(403);
    expect((await qualify(dealerA, A, lead, { outcome: 'qualified' })).status).toBe(403);
    const anon = await api(srv.base, null, 'POST', `/api/crm/leads/${lead}/qualify`, { outcome: 'qualified' });
    expect(anon.status).toBe(401);
  });

  /* ---------------- 8. cross-tenant qualify ---------------- */

  it('tenant A cannot qualify tenant B lead (404, B untouched)', async () => {
    const bLead = await createTestLead(pg, B, { name: 'B lead' });
    const r = await qualify(ownerA, A, bLead, { outcome: 'qualified' }, 'owner');
    expect(r.status).toBe(404);
    const row = await asShop(B, (c) => c.query(`SELECT qualification_status FROM crm_lead WHERE id = $1`, [bLead]));
    expect(row.rows[0].qualification_status).toBeNull();
  });

  it('client-supplied shop_id in body is rejected (400)', async () => {
    const lead = await createTestLead(pg, A, { name: 'Injector' });
    const r = await qualify(salesA, A, lead, { outcome: 'qualified', shop_id: B });
    expect(r.status).toBe(400);
  });

  /* ---------------- 9. branch / dealer scope ---------------- */

  it('branch-restricted user cannot qualify a lead outside their branch', async () => {
    const outScope = await createTestLead(pg, A, { name: 'Other branch', branchId: branchA2 });
    const inScope = await createTestLead(pg, A, { name: 'My branch', branchId: branchA1 });
    expect((await qualify(branchUserA, A, outScope, { outcome: 'qualified' })).status).toBe(404);
    expect((await qualify(branchUserA, A, inScope, { outcome: 'qualified' })).status).toBe(200);
  });

  /* ---------------- 10 + 11. activity + audit ---------------- */

  it('qualification writes an activity + audit row', async () => {
    const lead = await createTestLead(pg, A, { name: 'Trail' });
    await qualify(salesA, A, lead, { outcome: 'qualified', score: 55 });

    const acts = await asShop(A, (c) =>
      c.query(`SELECT type, data FROM crm_activity WHERE entity_type='lead' AND entity_id=$1 AND type='qualification'`, [lead]),
    );
    expect(acts.rows).toHaveLength(1);
    expect(acts.rows[0].data).toMatchObject({ outcome: 'qualified' });

    const aud = await asShop(A, (c) =>
      c.query(`SELECT action, after_data FROM crm_audit_log WHERE entity_type='lead' AND entity_id=$1 AND action='qualify'`, [lead]),
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0].after_data).toMatchObject({ qualification_status: 'qualified' });

    const evs = await asWorker((c) =>
      c.query(`SELECT event_type, payload FROM crm_outbox WHERE (payload->>'leadId') = $1 AND event_type='lead.qualified'`, [lead]),
    );
    expect(evs.rows.map((r: any) => r.payload.outcome)).toContain('qualified');
  });

  /* ---------------- 17. legacy body still works ---------------- */

  it('legacy { qualified: true } / { qualified: false } payloads still work', async () => {
    const l1 = await createTestLead(pg, A, { name: 'Legacy ok' });
    const r1 = await qualify(salesA, A, l1, { qualified: true });
    expect(r1.status).toBe(200);
    expect(r1.body.qualificationStatus).toBe('qualified');
    expect(r1.body.status).toBe('qualified');

    const l2 = await createTestLead(pg, A, { name: 'Legacy unqualify' });
    const r2 = await qualify(salesA, A, l2, { qualified: false, status: 'unqualified' });
    expect(r2.status).toBe(200); // legacy shape stays lenient — no reason required
    expect(r2.body.qualificationStatus).toBe('disqualified');
    expect(r2.body.status).toBe('unqualified');
  });

  /* ---------------- 12 + 15. promote qualified lead ---------------- */

  it('promotes a qualified lead into a linked opportunity that inherits lead fields', async () => {
    const cust = await createTestCustomer(pg, A, { name: 'Cust' });
    const lead = await createTestLead(pg, A, {
      name: 'Promote me', phone: '900777', assignedTo: salesA, branchId: branchA1,
    });
    await asShop(A, (c) =>
      c.query(`UPDATE crm_lead SET source = 'referral', customer_id = $2 WHERE id = $1`, [lead, cust]),
    );
    await qualify(salesA, A, lead, { outcome: 'qualified' });

    const r = await promote(salesA, A, lead, { amount: 125000 });
    expect(r.status).toBe(201);
    expect(r.body.alreadyPromoted).toBe(false);
    expect(r.body.opportunity.leadId).toBe(lead);
    expect(r.body.opportunity.branchId).toBe(branchA1);
    expect(r.body.opportunity.assignedTo).toBe(salesA);
    expect(r.body.opportunity.source).toBe('referral');
    expect(r.body.opportunity.customerId).toBe(cust);
    expect(r.body.opportunity.stage).toBe('qualification');
    expect(r.body.opportunity.amount).toBe(125000);

    const acts = await asShop(A, (c) =>
      c.query(`SELECT type FROM crm_activity WHERE entity_type='lead' AND entity_id=$1 AND type='promotion'`, [lead]),
    );
    expect(acts.rows).toHaveLength(1);
    const aud = await asShop(A, (c) =>
      c.query(`SELECT action FROM crm_audit_log WHERE entity_type='lead' AND entity_id=$1 AND action='promote'`, [lead]),
    );
    expect(aud.rows).toHaveLength(1);
    const evs = await asWorker((c) =>
      c.query(`SELECT event_type FROM crm_outbox WHERE (payload->>'leadId') = $1 AND event_type='lead.promoted'`, [lead]),
    );
    expect(evs.rows).toHaveLength(1);
  });

  /* ---------------- 13. promote rejected when unqualified ---------------- */

  it('promotion of a non-qualified lead is rejected (409)', async () => {
    const lead = await createTestLead(pg, A, { name: 'Not qualified' });
    const r = await promote(salesA, A, lead);
    expect(r.status).toBe(409);
    const opps = await asShop(A, (c) => c.query(`SELECT 1 FROM crm_opportunity WHERE lead_id = $1`, [lead]));
    expect(opps.rows).toHaveLength(0);
  });

  /* ---------------- 14. duplicate promotion prevented ---------------- */

  it('promoting twice is idempotent — returns the existing opportunity', async () => {
    const lead = await createTestLead(pg, A, { name: 'Dupe promote' });
    await qualify(salesA, A, lead, { outcome: 'qualified' });

    const first = await promote(salesA, A, lead);
    expect(first.status).toBe(201);
    const oppId = first.body.opportunity.id;

    const second = await promote(salesA, A, lead);
    expect(second.status).toBe(200);
    expect(second.body.alreadyPromoted).toBe(true);
    expect(second.body.opportunity.id).toBe(oppId);

    const count = await asShop(A, (c) =>
      c.query(`SELECT count(*)::int AS n FROM crm_opportunity WHERE lead_id = $1`, [lead]),
    );
    expect(count.rows[0].n).toBe(1);
  });

  /* ---------------- 16. tenant isolation + authz on promotion ---------------- */

  it('promotion: cross-tenant 404, support role 403, no token 401', async () => {
    const bLead = await createTestLead(pg, B, { name: 'B promote' });
    await asShop(B, (c) => c.query(`UPDATE crm_lead SET status='qualified', qualification_status='qualified' WHERE id=$1`, [bLead]));
    expect((await promote(ownerA, A, bLead, {}, 'owner')).status).toBe(404);

    const aLead = await createTestLead(pg, A, { name: 'A promote authz' });
    await qualify(salesA, A, aLead, { outcome: 'qualified' });
    expect((await promote(supportA, A, aLead)).status).toBe(403);
    const anon = await api(srv.base, null, 'POST', `/api/crm/leads/${aLead}/promote`, {});
    expect(anon.status).toBe(401);
  });
});
