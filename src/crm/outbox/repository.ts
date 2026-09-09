/**
 * CRM transactional outbox — data access.
 *
 * The outbox is how CRM schedules reliable asynchronous work (notifications
 * now; WhatsApp / email / automation in later phases). A write is enqueued in
 * the SAME transaction as the state change it reflects (the transactional
 * outbox pattern).
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` so multiple worker instances can run
 * concurrently without ever processing the same row twice.
 */

import type { Pool, PoolClient } from 'pg';
import { pgPool } from '../../config/postgres';
import { generateId } from '../../utils/id';

export type OutboxStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface OutboxRow {
  id: string;
  shop_id: string;
  event_type: string;
  payload: Record<string, any>;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  claimed_at: Date | null;
  processed_at: Date | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueOutboxInput {
  shopId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  runAfter?: Date | null;
  maxAttempts?: number;
  dedupeKey?: string | null;
}

/**
 * Enqueue a job. Pass a tx `client` to enqueue atomically with a state
 * change. Returns the row, or null if a dedupeKey collision made it a no-op.
 */
export async function enqueueOutbox(
  input: EnqueueOutboxInput,
  client?: Pool | PoolClient,
): Promise<OutboxRow | null> {
  const exec: Pool | PoolClient = client ?? pgPool;
  if (!input.shopId) throw new Error('enqueueOutbox: shopId is required');
  if (!input.eventType) throw new Error('enqueueOutbox: eventType is required');
  const { rows } = await exec.query(
    `INSERT INTO crm_outbox
       (id, shop_id, event_type, payload, run_after, max_attempts, dedupe_key)
     VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6,$7)
     ON CONFLICT (shop_id, dedupe_key) WHERE dedupe_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      generateId('crmob'),
      input.shopId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.runAfter ?? null,
      input.maxAttempts ?? 5,
      input.dedupeKey ?? null,
    ],
  );
  return (rows[0] as OutboxRow) ?? null;
}

/**
 * Atomically claim up to `limit` due jobs: flips them to 'processing',
 * bumps `attempts`, stamps `claimed_at`. Concurrent callers never get the
 * same row (SKIP LOCKED).
 */
export async function claimOutboxBatch(
  limit = 10,
  client?: Pool | PoolClient,
): Promise<OutboxRow[]> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const { rows } = await exec.query(
    `UPDATE crm_outbox o
        SET status = 'processing',
            attempts = o.attempts + 1,
            claimed_at = now(),
            updated_at = now()
      WHERE o.id IN (
        SELECT id FROM crm_outbox
         WHERE status = 'pending'
           AND run_after <= now()
         ORDER BY run_after ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING *`,
    [limit],
  );
  return rows as OutboxRow[];
}

export async function markOutboxCompleted(id: string, client?: Pool | PoolClient): Promise<void> {
  const exec: Pool | PoolClient = client ?? pgPool;
  await exec.query(
    `UPDATE crm_outbox
        SET status = 'completed', processed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

/**
 * Record a failed attempt. If attempts remain, the row goes back to 'pending'
 * with an exponential-ish backoff; otherwise it is parked as 'failed'.
 */
export async function markOutboxFailed(
  id: string,
  error: unknown,
  client?: Pool | PoolClient,
): Promise<void> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const safeError = String(error).slice(0, 4000);
  await exec.query(
    `UPDATE crm_outbox
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            run_after = CASE
              WHEN attempts >= max_attempts THEN run_after
              ELSE now() + (make_interval(secs => LEAST(3600, power(2, attempts) * 30)))
            END,
            processed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE processed_at END,
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, safeError],
  );
}

/**
 * Recover jobs stuck in 'processing' (e.g. a worker crashed mid-run). Any row
 * claimed longer than `olderThanSeconds` ago is returned to 'pending'.
 */
export async function requeueStuckOutbox(
  olderThanSeconds = 300,
  client?: Pool | PoolClient,
): Promise<number> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const res = await exec.query(
    `UPDATE crm_outbox
        SET status = 'pending', updated_at = now()
      WHERE status = 'processing'
        AND claimed_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return res.rowCount ?? 0;
}

export async function getOutboxRow(id: string, client?: Pool | PoolClient): Promise<OutboxRow | null> {
  const exec: Pool | PoolClient = client ?? pgPool;
  const { rows } = await exec.query(`SELECT * FROM crm_outbox WHERE id = $1`, [id]);
  return (rows[0] as OutboxRow) ?? null;
}
