/**
 * Shared DB harness for the CRM DB-backed test suites.
 *
 * These suites run ONLY when `TEST_DATABASE_URL` is set (see vitest.config.ts)
 * and they create + cascade-delete their own throw-away shops, so the target
 * must never be a database you care about.
 *
 * `asShop()` / `asWorker()` are the test-side equivalents of
 * src/utils/db.ts::withTenant / withWorkerTx — they set the same
 * `app.shop_id` / `app.crm_worker` GUCs so the CRM RLS policies apply exactly
 * as they do in the real request path.
 */

import { Pool, PoolClient } from 'pg';
import { generateId } from '../../utils/id';

export type Pg = Pool;

export const RUN_DB = !!process.env.TEST_DATABASE_URL;

let pool: Pool | null = null;

/** Lazily open (and memoise) the throw-away test pool. */
export async function loadPool(): Promise<Pool> {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('loadPool: TEST_DATABASE_URL is not set');
  }
  if (!pool) {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
  }
  return pool;
}

function requirePool(): Pool {
  if (!pool) throw new Error('_dbHelper: call loadPool() first');
  return pool;
}

/** Run `cb` in a transaction bound to one shop (sets app.shop_id). */
export async function asShop<T>(shopId: string, cb: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const out = await cb(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Run `cb` in a transaction flagged as CRM worker work (sets app.crm_worker). */
export async function asWorker<T>(cb: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.crm_worker', 'on', true)`);
    const out = await cb(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Fail loudly if the CRM Phase 1/2 schema (+ RLS) is not present. */
export async function assertCrmSchema(pg: Pool): Promise<void> {
  const { rows } = await pg.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('crm_lead','crm_activity','crm_opportunity','crm_task','crm_outbox')`,
  );
  const byName = new Map(rows.map((r: any) => [r.relname, r]));
  for (const t of ['crm_lead', 'crm_activity', 'crm_opportunity', 'crm_task', 'crm_outbox']) {
    const r = byName.get(t);
    if (!r) throw new Error(`assertCrmSchema: table ${t} missing — run "npm run migrate" against the test DB`);
    if (!r.relrowsecurity || !r.relforcerowsecurity) {
      throw new Error(`assertCrmSchema: ${t} is not under FORCE row-level security`);
    }
  }
}

/* --------------------------------------------------------------- */
/* fixtures                                                         */
/* --------------------------------------------------------------- */

export async function createTestShop(pg: Pool, prefix = 'crmtest'): Promise<string> {
  const id = generateId(`shop_${prefix}`);
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 86400000);
  await pg.query(
    `INSERT INTO shops
       (id, slug, shop_name, status, plan,
        subscription_start_date, subscription_end_date, initial_admin_username)
     VALUES ($1,$2,$3,'active','premium',$4,$5,$6)`,
    [id, id, `${prefix} shop`, now, end, `${prefix}_admin`],
  );
  return id;
}

export async function createTestUser(
  pg: Pool,
  shopId: string,
  opts: { role?: 'owner' | 'operator' | 'karigar'; crmRole?: string | null; permissions?: string[] } = {},
): Promise<string> {
  const id = generateId('user_crmtest');
  await pg.query(
    `INSERT INTO users
       (id, shop_id, username, password_hash, name, role, is_active, crm_role, permissions)
     VALUES ($1,$2,$3,'x',$4,$5,true,$6,$7)`,
    [
      id,
      shopId,
      id,
      `Test ${opts.role ?? 'operator'}`,
      opts.role ?? 'operator',
      opts.crmRole ?? null,
      opts.permissions ?? [],
    ],
  );
  return id;
}

export async function createTestBranch(pg: Pool, shopId: string, name = 'Main'): Promise<string> {
  const id = generateId('branch_crmtest');
  await asShop(shopId, (c) =>
    c.query(`INSERT INTO branches (id, shop_id, name) VALUES ($1,$2,$3)`, [id, shopId, name]),
  );
  return id;
}

export async function createTestLead(
  pg: Pool,
  shopId: string,
  opts: { name?: string; phone?: string | null; assignedTo?: string | null; branchId?: string | null } = {},
): Promise<string> {
  const id = generateId('crmlead_test');
  await asShop(shopId, (c) =>
    c.query(
      `INSERT INTO crm_lead (id, shop_id, name, phone, assigned_to, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, shopId, opts.name ?? 'Test Lead', opts.phone ?? null, opts.assignedTo ?? null, opts.branchId ?? null],
    ),
  );
  return id;
}

export async function createTestOpportunity(
  pg: Pool,
  shopId: string,
  opts: {
    title?: string;
    amount?: number | null;
    stage?: string;
    branchId?: string | null;
    assignedTo?: string | null;
    leadId?: string | null;
    customerId?: string | null;
  } = {},
): Promise<string> {
  const id = generateId('crmopp_test');
  await asShop(shopId, (c) =>
    c.query(
      `INSERT INTO crm_opportunity
         (id, shop_id, title, amount, stage, branch_id, assigned_to, lead_id, customer_id)
       VALUES ($1,$2,$3,$4,COALESCE($5,'prospecting'),$6,$7,$8,$9)`,
      [
        id,
        shopId,
        opts.title ?? 'Test Opp',
        opts.amount ?? null,
        opts.stage ?? null,
        opts.branchId ?? null,
        opts.assignedTo ?? null,
        opts.leadId ?? null,
        opts.customerId ?? null,
      ],
    ),
  );
  return id;
}

export async function createTestTask(
  pg: Pool,
  shopId: string,
  opts: {
    title?: string;
    assignedTo?: string | null;
    branchId?: string | null;
    status?: string;
    priority?: string;
    dueAt?: Date | null;
    relatedType?: string | null;
    relatedId?: string | null;
  } = {},
): Promise<string> {
  const id = generateId('crmtask_test');
  await asShop(shopId, (c) =>
    c.query(
      `INSERT INTO crm_task
         (id, shop_id, title, assigned_to, branch_id, status, priority, due_at, related_type, related_id)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'open'),COALESCE($7,'medium'),$8,$9,$10)`,
      [
        id,
        shopId,
        opts.title ?? 'Test Task',
        opts.assignedTo ?? null,
        opts.branchId ?? null,
        opts.status ?? null,
        opts.priority ?? null,
        opts.dueAt ?? null,
        opts.relatedType ?? null,
        opts.relatedId ?? null,
      ],
    ),
  );
  return id;
}

/** Cascade-delete a throw-away shop and everything under it. */
export async function dropTestShop(pg: Pool, shopId: string): Promise<void> {
  await pg.query(`DELETE FROM shops WHERE id = $1`, [shopId]);
}
