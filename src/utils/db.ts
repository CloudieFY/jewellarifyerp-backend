import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const result = await callback(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `callback` inside a transaction that is bound to one shop.
 *
 * It sets the transaction-local GUC `app.shop_id`, which is the carrier the
 * CRM row-level-security policies read
 * (`shop_id = current_setting('app.shop_id', true)`). Every CRM table is
 * under FORCE RLS (migrations 009/010/011), so a query issued outside this
 * helper sees no rows and cannot insert — the module fails CLOSED.
 *
 * `shopId` must always be the caller's verified `req.pgTenant.shopId`, never
 * a value taken from request input. The third `set_config` arg (`true`) makes
 * the setting local to the transaction, so it is cleared automatically on
 * COMMIT / ROLLBACK and can never leak onto a pooled connection.
 */
export async function withTenant<T>(
  shopId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!shopId) throw new Error('withTenant: shopId is required');
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `callback` inside a transaction flagged as CRM worker work.
 *
 * The CRM outbox worker is the ONE cross-tenant consumer (it drains every
 * shop's jobs from a single loop). It cannot set `app.shop_id` because it
 * spans shops, so instead it sets `app.crm_worker = 'on'`, which ONLY the
 * `crm_outbox` RLS policy recognises. Every other CRM table stays invisible
 * here — individual handlers re-enter `withTenant(row.shop_id, …)` to do
 * their per-shop work.
 */
export async function withWorkerTx<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.crm_worker', 'on', true)`);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
