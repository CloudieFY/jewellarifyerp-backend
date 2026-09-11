import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestLead,
  createTestOpportunity,
  createTestDemo,
  createTestQuotation,
  dropTestShop,
  asShop,
  type Pg,
} from './_dbHelper';
import { startCrmServer, api, type CrmTestServer } from './_serverHelper';

const HAVE_TENANT_SECRET = !!process.env.JWT_TENANT_SECRET;
const HAVE_SUPERADMIN_SECRET = !!(process.env.JWT_SECRET || process.env.JWT_SUPERADMIN_SECRET);

/**
 * DB-backed tests for Slice 4: Demo Management + Quotation foundation
 * (/api/superadmin/crm/{demos,quotations}/*).
 */
describe.skipIf(!RUN_DB || !HAVE_TENANT_SECRET || !HAVE_SUPERADMIN_SECRET)('Super Admin CRM Slice 4 — demos + quotations', () => {
  let pg: Pg;
  let srv: CrmTestServer;
  let signTenantToken: typeof import('../../utils/jwt').signTenantToken;
  let signSuperAdminToken: typeof import('../../utils/jwt').signSuperAdminToken;

  let A: string;
  let B: string;
  let ownerA: string;
  let ownerB: string;
  let leadA: string;
  let oppA: string;
  let demoA: string;
  let quotationA: string;
  let saToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);
    ({ signTenantToken, signSuperAdminToken } = await import('../../utils/jwt'));

    A = await createTestShop(pg, 'sa_s4_a');
    B = await createTestShop(pg, 'sa_s4_b');
    ownerA = await createTestUser(pg, A, { role: 'owner', crmRole: 'crm_admin' });
    ownerB = await createTestUser(pg, B, { role: 'owner', crmRole: 'crm_admin' });

    leadA = await createTestLead(pg, A, { name: 'Lead A1' });
    oppA = await createTestOpportunity(pg, A, { title: 'Opp A1', amount: 5000, leadId: leadA });
    demoA = await createTestDemo(pg, A, { opportunityId: oppA, leadId: leadA });
    quotationA = await createTestQuotation(pg, A, oppA, { title: 'Quote A1', amount: 4000 });

    saToken = signSuperAdminToken({ sub: 'superadmin_test_id', username: 'superadmin_test' });
    tenantToken = signTenantToken({ sub: ownerA, shopId: A, username: ownerA, role: 'owner' });

    srv = await startCrmServer();
  });

  afterAll(async () => {
    await srv?.close();
    await dropTestShop(pg, A);
    await dropTestShop(pg, B);
  });

  /* ------------------------------------------------------------------ */
  /* Security                                                            */
  /* ------------------------------------------------------------------ */

  it('no token is rejected on demos and quotations', async () => {
    expect((await api(srv.base, null, 'GET', '/api/superadmin/crm/demos')).status).toBe(401);
    expect((await api(srv.base, null, 'GET', '/api/superadmin/crm/quotations')).status).toBe(401);
  });

  it('tenant token is rejected on demos and quotations, including new action routes', async () => {
    const paths = [
      ['GET', '/api/superadmin/crm/demos'],
      ['GET', `/api/superadmin/crm/demos/${A}/${demoA}`],
      ['GET', `/api/superadmin/crm/demos/${A}/${demoA}/activities`],
      ['POST', `/api/superadmin/crm/demos/${A}/${demoA}/complete`],
      ['GET', '/api/superadmin/crm/quotations'],
      ['GET', `/api/superadmin/crm/quotations/${A}/${quotationA}`],
      ['GET', `/api/superadmin/crm/quotations/by-opportunity/${A}/${oppA}`],
      ['POST', `/api/superadmin/crm/quotations/${A}/${quotationA}/send`],
    ] as const;
    for (const [method, path] of paths) {
      const r = await api(srv.base, tenantToken, method, path, method === 'POST' ? {} : undefined);
      expect([401, 403]).toContain(r.status);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Demo CRUD + cross-shop visibility + IDOR                            */
  /* ------------------------------------------------------------------ */

  it('GET /demos is cross-shop and Super Admin sees the seeded demo', async () => {
    const r = await api(srv.base, saToken, 'GET', '/api/superadmin/crm/demos?limit=100');
    expect(r.status).toBe(200);
    expect(r.body.data.some((d: any) => d.id === demoA)).toBe(true);
    const row = r.body.data.find((d: any) => d.id === demoA);
    expect(row.shopName).toBeTruthy();
    expect(row.leadId).toBe(leadA);
    expect(row.opportunityId).toBe(oppA);
  });

  it('GET /demos/:shopId/:id — correct shop 200s, wrong shop 404s (IDOR check)', async () => {
    const ok = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/demos/${A}/${demoA}`);
    expect(ok.status).toBe(200);
    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/demos/${B}/${demoA}`);
    expect(wrongShop.status).toBe(404);
  });

  it('POST /demos/:shopId requires leadId or opportunityId and a scheduledAt', async () => {
    const noAnchor = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, { scheduledAt: new Date().toISOString() });
    expect(noAnchor.status).toBe(400);

    const noSchedule = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, { opportunityId: oppA });
    expect(noSchedule.status).toBe(400);
  });

  it('POST /demos/:shopId schedules a demo scoped to that shop, rejects a cross-shop lead/opportunity', async () => {
    const crossShop = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, {
      opportunityId: oppA, scheduledAt: new Date().toISOString(), leadId: 'not-a-real-id-in-any-shop',
    });
    // a made-up leadId that isn't a real row in shop A must be rejected
    expect(crossShop.status).toBe(400);

    const created = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, {
      opportunityId: oppA, leadId: leadA, scheduledAt: new Date(Date.now() + 3600_000).toISOString(), mode: 'in_store',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('scheduled');
    expect(created.body.mode).toBe('in_store');

    const visibleInA = await asShop(A, (c) => c.query(`SELECT id FROM crm_demo WHERE id = $1`, [created.body.id]));
    expect(visibleInA.rows.length).toBe(1);
    const visibleInB = await asShop(B, (c) => c.query(`SELECT id FROM crm_demo WHERE id = $1`, [created.body.id]));
    expect(visibleInB.rows.length).toBe(0);

    const audit = await asShop(A, (c) => c.query(`SELECT actor_user_id, metadata FROM crm_audit_log WHERE entity_id = $1 AND action = 'create'`, [created.body.id]));
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].metadata.actorSuperAdminId).toBe('superadmin_test_id');
  });

  it('demo assign is rejected for a user outside the target shop', async () => {
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoA}/assign`, { assignedTo: ownerB });
    expect(r.status).toBe(400);
  });

  /* ------------------------------------------------------------------ */
  /* Demo status transitions / completion / outcome                      */
  /* ------------------------------------------------------------------ */

  it('POST /demos/:shopId/:id/complete requires an outcome, sets completed_at, blocks a second close', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, {
      opportunityId: oppA, scheduledAt: new Date().toISOString(),
    });
    const demoId = fresh.body.id;

    const noOutcome = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoId}/complete`, {});
    expect(noOutcome.status).toBe(400);

    const done = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoId}/complete`, {
      outcome: 'interested', nextAction: 'Send quotation', notes: 'Loved the design',
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.outcome).toBe('interested');
    expect(done.body.nextAction).toBe('Send quotation');
    expect(done.body.completedAt).toBeTruthy();

    const again = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoId}/complete`, { outcome: 'interested' });
    expect(again.status).toBe(409);
  });

  it('POST /demos/:shopId/:id/cancel marks cancelled or no_show, blocks editing after close', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, {
      opportunityId: oppA, scheduledAt: new Date().toISOString(),
    });
    const demoId = fresh.body.id;

    const cancelled = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoId}/cancel`, { reason: 'Customer rescheduled' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    const editAfterClose = await api(srv.base, saToken, 'PATCH', `/api/superadmin/crm/demos/${A}/${demoId}`, { notes: 'should not apply' });
    expect(editAfterClose.status).toBe(409);
  });

  it('demo no-show path sets status no_show', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}`, {
      opportunityId: oppA, scheduledAt: new Date().toISOString(),
    });
    const r = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${fresh.body.id}/cancel`, { noShow: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('no_show');
  });

  /* ------------------------------------------------------------------ */
  /* Demo activities + follow-up linkage                                 */
  /* ------------------------------------------------------------------ */

  it('demo activities: GET/POST works and is scoped by :shopId (IDOR check)', async () => {
    const empty = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/demos/${A}/${demoA}/activities`);
    expect(empty.status).toBe(200);

    const added = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/demos/${A}/${demoA}/activities`, { body: 'Reminded customer', type: 'call' });
    expect(added.status).toBe(201);

    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/demos/${B}/${demoA}/activities`);
    expect(wrongShop.status).toBe(404);
  });

  it('follow-up task can link to a demo via related_type=demo and is visible via the cross-shop task filter', async () => {
    const created = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/tasks/${A}`, {
      title: 'Follow up after demo', relatedType: 'demo', relatedId: demoA,
    });
    expect(created.status).toBe(201);

    const filtered = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/tasks?related_type=demo&related_id=${demoA}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.some((t: any) => t.id === created.body.id)).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* Quotation CRUD + Opportunity relationship + IDOR                    */
  /* ------------------------------------------------------------------ */

  it('POST /quotations/:shopId requires a title and a valid opportunityId', async () => {
    const noTitle = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}`, { opportunityId: oppA });
    expect(noTitle.status).toBe(400);

    const badOpp = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}`, { title: 'X', opportunityId: 'not-real' });
    expect(badOpp.status).toBe(400);

    const crossShopOpp = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${B}`, { title: 'X', opportunityId: oppA });
    expect(crossShopOpp.status).toBe(400); // oppA belongs to shop A, not B
  });

  it('GET /quotations/by-opportunity/:shopId/:opportunityId returns this opportunity\'s quotations only', async () => {
    const r = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/quotations/by-opportunity/${A}/${oppA}`);
    expect(r.status).toBe(200);
    expect(r.body.some((q: any) => q.id === quotationA)).toBe(true);
    expect(r.body.every((q: any) => q.opportunityId === oppA)).toBe(true);

    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/quotations/by-opportunity/${B}/${oppA}`);
    expect(wrongShop.status).toBe(404); // oppA is not shop B's opportunity
  });

  it('GET /quotations/:shopId/:id — correct shop 200s, wrong shop 404s (IDOR check)', async () => {
    const ok = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/quotations/${A}/${quotationA}`);
    expect(ok.status).toBe(200);
    expect(ok.body.opportunityId).toBe(oppA);
    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/quotations/${B}/${quotationA}`);
    expect(wrongShop.status).toBe(404);
  });

  it('quotation created via API also writes an activity onto the parent opportunity\'s timeline', async () => {
    const created = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}`, { title: 'Linked Quote', opportunityId: oppA, amount: 2500 });
    expect(created.status).toBe(201);

    const oppActivities = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/opportunities/${A}/${oppA}/activities`);
    expect(oppActivities.status).toBe(200);
    expect(oppActivities.body.data.some((a: any) => a.body?.includes('Linked Quote'))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* Quotation status transitions                                        */
  /* ------------------------------------------------------------------ */

  it('quotation status transitions: draft -> sent -> accepted, invalid transitions rejected', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}`, { title: 'Transition Quote', opportunityId: oppA, amount: 1000 });
    const qId = fresh.body.id;

    const acceptBeforeSend = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/accept`, {});
    expect(acceptBeforeSend.status).toBe(409);

    const sent = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/send`, {});
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.sentAt).toBeTruthy();

    const sentAgain = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/send`, {});
    expect(sentAgain.status).toBe(409);

    const editAfterSend = await api(srv.base, saToken, 'PATCH', `/api/superadmin/crm/quotations/${A}/${qId}`, { title: 'Still editable while sent' });
    expect(editAfterSend.status).toBe(200); // 'sent' is still an OPEN_QUOTATION_STATUS

    const accepted = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.acceptedAt).toBeTruthy();

    const editAfterAccept = await api(srv.base, saToken, 'PATCH', `/api/superadmin/crm/quotations/${A}/${qId}`, { title: 'should be blocked' });
    expect(editAfterAccept.status).toBe(409);
  });

  it('quotation reject path sets rejectedAt', async () => {
    const fresh = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}`, { title: 'Reject Quote', opportunityId: oppA });
    const qId = fresh.body.id;
    await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/send`, {});
    const rejected = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${qId}/reject`, {});
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.rejectedAt).toBeTruthy();
  });

  it('quotation activities: GET/POST works and is scoped by :shopId (IDOR check)', async () => {
    const added = await api(srv.base, saToken, 'POST', `/api/superadmin/crm/quotations/${A}/${quotationA}/activities`, { body: 'Discussed pricing', type: 'call' });
    expect(added.status).toBe(201);
    const wrongShop = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/quotations/${B}/${quotationA}/activities`);
    expect(wrongShop.status).toBe(404);
  });

  /* ------------------------------------------------------------------ */
  /* GET /dashboard, /demos, /quotations cross-shop — sanity              */
  /* ------------------------------------------------------------------ */

  it('cross-shop demo and quotation lists never leak shop B rows into a shop-A-scoped drilldown', async () => {
    const demoB = await createTestDemo(pg, B, { opportunityId: null, leadId: (await createTestLead(pg, B, { name: 'Lead B1' })) });
    const drilldownWrong = await api(srv.base, saToken, 'GET', `/api/superadmin/crm/demos/${A}/${demoB}`);
    expect(drilldownWrong.status).toBe(404);
  });
});
