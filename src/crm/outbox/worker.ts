/**
 * CRM outbox worker loop.
 *
 * Claims due `crm_outbox` rows with FOR UPDATE SKIP LOCKED and dispatches them
 * to a handler registry. An unknown event type is failed with a clear reason
 * (and retried per the row's backoff until max_attempts).
 *
 * RLS: `crm_outbox` is under FORCE row-level security (migration 009). The
 * worker is the ONE cross-tenant consumer, so every DB touch here runs inside
 * `withWorkerTx()` which sets the transaction-local `app.crm_worker = 'on'`
 * flag the outbox policy recognises. Individual handlers still scope their own
 * work to a single shop via `withTenant(row.shop_id, ...)`.
 *
 * Handlers are registered by CRM feature modules via `registerOutboxHandler()`.
 */

import { withWorkerTx } from '../../utils/db';
import type { OutboxRow } from './repository';
import {
  claimOutboxBatch,
  markOutboxCompleted,
  markOutboxFailed,
  requeueStuckOutbox,
} from './repository';

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

export interface RunOnceResult {
  claimed: number;
  completed: number;
  failed: number;
}

const handlers = new Map<string, OutboxHandler>();

export function registerOutboxHandler(eventType: string, handler: OutboxHandler): void {
  handlers.set(eventType, handler);
}

export function getRegisteredEventTypes(): string[] {
  return [...handlers.keys()];
}

/** Test/bootstrap aid — drop all registrations. */
export function _clearOutboxHandlers(): void {
  handlers.clear();
}

/** Process a single batch. Returns counts; never throws. */
export async function runOnce(batchSize = 10): Promise<RunOnceResult> {
  const result: RunOnceResult = { claimed: 0, completed: 0, failed: 0 };
  let batch: OutboxRow[] = [];
  try {
    batch = await withWorkerTx((c) => claimOutboxBatch(batchSize, c));
  } catch (err: any) {
    console.error('[crm worker] claim failed:', err?.message || err);
    return result;
  }
  result.claimed = batch.length;

  for (const row of batch) {
    const handler = handlers.get(row.event_type);
    if (!handler) {
      await safeMarkFailed(row.id, `no handler registered for event_type "${row.event_type}"`);
      result.failed += 1;
      continue;
    }
    try {
      await handler(row);
      await withWorkerTx((c) => markOutboxCompleted(row.id, c));
      result.completed += 1;
    } catch (err: any) {
      await safeMarkFailed(row.id, err?.stack || err?.message || String(err));
      result.failed += 1;
    }
  }
  return result;
}

async function safeMarkFailed(id: string, error: unknown): Promise<void> {
  try {
    await withWorkerTx((c) => markOutboxFailed(id, error, c));
  } catch (err: any) {
    console.error('[crm worker] markOutboxFailed error:', err?.message || err);
  }
}

export interface OutboxWorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. Returns a handle whose `stop()` waits for the
 * current tick to finish (graceful shutdown).
 */
export function startOutboxWorker(opts?: {
  intervalMs?: number;
  batchSize?: number;
  stuckSweepEverySeconds?: number;
}): OutboxWorkerHandle {
  const intervalMs = opts?.intervalMs ?? 5000;
  const batchSize = opts?.batchSize ?? 10;
  const stuckSweepEverySeconds = opts?.stuckSweepEverySeconds ?? 300;

  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let lastStuckSweep = 0;

  const tick = async () => {
    if (stopped) return;
    running = (async () => {
      try {
        const now = Date.now();
        if (now - lastStuckSweep > stuckSweepEverySeconds * 1000) {
          lastStuckSweep = now;
          const requeued = await withWorkerTx((c) => requeueStuckOutbox(stuckSweepEverySeconds, c));
          if (requeued > 0) console.log(`[crm worker] requeued ${requeued} stuck job(s)`);
        }
        const r = await runOnce(batchSize);
        if (r.claimed > 0) {
          console.log(`[crm worker] batch: claimed=${r.claimed} completed=${r.completed} failed=${r.failed}`);
        }
      } catch (err: any) {
        console.error('[crm worker] tick error:', err?.message || err);
      }
    })();
    await running;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
