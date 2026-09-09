import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_DB,
  loadPool,
  assertCrmSchema,
  createTestShop,
  createTestUser,
  createTestOpportunity,
  createTestTask,
  dropTestShop,
  asShop,
  asWorker,
  type Pg,
} from './_dbHelper';

/**
 * DB-backed. Proves crm_opportunity / crm_task (migration 011) are under FORCE
 * row-level security exactly like the Phase 0/1 CRM tables: a query without
 * tenant context sees nothing and cannot insert, and tenant A can never reach
 * tenant B's rows. Runs only with TEST_DATABASE_URL.
 */
describe.skipIf(!RUN_DB)('CRM Phase 2 tenant isolation (RLS)', () => {
  let pg: Pg;
  let A: string;
  let B: string;
  let oppA: string;
  let oppB: string;
  let taskA: string;
  let taskB: string;

  beforeAll(async () => {
    pg = await loadPool();
    await assertCrmSchema(pg);

    A = await createTestShop(pg, 'p2A');
    B = await createTestShop(pg, 'p2B');
    await createTestUser(pg, A, { role: 'owner' });
    await createTestUser(pg, B, { role: 'owner' });

    oppA = await createTestOpportunity(pg, A, { title: 'A opp', amount: 10 });
    oppB = await createTestOpportunity(pg, B, { title: 'B opp', amount: 20 });
    taskA = await createTestTask(pg, A, { title: 'A task' });
    taskB = await createTestTask(pg, B, { title: 'B task' });

    // an opportunity-scoped activity row on each shop
    await asShop(A, (c) =>
      c.query(
        `INSERT INTO crm_activity (id, shop_id, entity_type, entity_id, type, body)
         VALUES ($1,$2,'opportunity',$3,'note','A note')`,
        [`test_act_${Date.now()}_a`, A, oppA],
      ),
    );
    await asShop(B, (c) =>
      c.query(
        `INSERT INTO crm_activity (id, shop_id, entity_type, entity_id, type, body)
         VALUES ($1,$2,'opportunity',$3,'note','B note')`,
        [`test_act_${Date.now()}_b`, B, oppB],
      ),
    );
  });

  afterAll(async () => {
    if (A) await dropTestShop(pg, A);
    if (B) await dropTestShop(pg, B);
  });

  it('bare pool (no tenant context) sees ZERO rows — fails closed', async () => {
    for (const t of ['crm_opportunity', 'crm_task']) {
      const { rows } = await pg.query(`SELECT 1 FROM ${t} LIMIT 1`);
      expect(rows).toHaveLength(0);
    }
  });

  it('opportunities: A only sees its own, even asking for B\'s id', async () => {
    const mine = await asShop(A, (c) => c.query(`SELECT id FROM crm_opportunity`));
    expect(mine.rows.map((r: any) => r.id)).toEqual([oppA]);
    const cross = await asShop(A, (c) => c.query(`SELECT id FROM crm_opportunity WHERE id = $1`, [oppB]));
    expect(cross.rows).toHaveLength(0);
  });

  it('tasks: A only sees its own', async () => {
    const mine = await asShop(A, (c) => c.query(`SELECT id FROM crm_task`));
    expect(mine.rows.map((r: any) => r.id)).toEqual([taskA]);
    const cross = await asShop(A, (c) => c.query(`SELECT id FROM crm_task WHERE id = $1`, [taskB]));
    expect(cross.rows).toHaveLength(0);
  });

  it('A cannot INSERT a crm_opportunity / crm_task row for shop B (RLS WITH CHECK)', async () => {
    await expect(
      asShop(A, (c) =>
        c.query(`INSERT INTO crm_opportunity (id, shop_id, title) VALUES ($1,$2,'evil')`, ['x_evil_opp', B]),
      ),
    ).rejects.toThrow();
    await expect(
      asShop(A, (c) => c.query(`INSERT INTO crm_task (id, shop_id, title) VALUES ($1,$2,'evil')`, ['x_evil_task', B])),
    ).rejects.toThrow();
  });

  it('opportunity activity rows are shop-scoped', async () => {
    const a = await asShop(A, (c) => c.query(`SELECT body FROM crm_activity WHERE entity_type = 'opportunity'`));
    expect(a.rows.map((r: any) => r.body)).toEqual(['A note']);
  });

  it('deleting shop A cascades crm_opportunity / crm_task; B untouched', async () => {
    await dropTestShop(pg, A);
    const gone = await asWorker(async (c) => {
      const out = [];
      for (const t of ['crm_opportunity', 'crm_task']) {
        out.push(await c.query(`SELECT 1 FROM ${t} WHERE shop_id = $1`, [A]));
      }
      return out;
    });
    for (const g of gone) expect(g.rows).toHaveLength(0);

    const bStill = await asShop(B, (c) => c.query(`SELECT 1 FROM crm_opportunity`));
    expect(bStill.rows.length).toBeGreaterThanOrEqual(1);
    A = '';
  });
});
