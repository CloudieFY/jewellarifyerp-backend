/**
 * Reusable CRM audit writer.
 *
 * Call `recordAudit()` from CRM write paths instead of hand-writing INSERTs.
 * It is tenant-scoped (shop_id is required and comes from the caller's
 * verified context), redacts sensitive fields, and NEVER throws — an audit
 * failure must not break the business operation it describes.
 */

import type { Pool, PoolClient } from 'pg';
import { pgPool } from '../../config/postgres';
import { generateId } from '../../utils/id';
import { redactSensitive } from './redact';

export interface AuditEntry {
  shopId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

/**
 * Insert one audit row. Pass a tx `client` to make the audit atomic with the
 * change; otherwise it uses the shared pool.
 */
export async function recordAudit(entry: AuditEntry, client?: Pool | PoolClient): Promise<void> {
  const exec: Pool | PoolClient = client ?? pgPool;
  try {
    if (!entry.shopId) {
      // Loud in logs, silent to the caller — a missing shopId is a bug but
      // must not abort the operation.
      console.error('[crm audit] missing shopId; skipping audit row', {
        entityType: entry.entityType,
        action: entry.action,
      });
      return;
    }
    await exec.query(
      `INSERT INTO crm_audit_log
         (id, shop_id, branch_id, actor_user_id, entity_type, entity_id,
          action, before_data, after_data, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        generateId('crmaud'),
        entry.shopId,
        entry.branchId ?? null,
        entry.actorUserId ?? null,
        entry.entityType,
        entry.entityId ?? null,
        entry.action,
        entry.before === undefined ? null : JSON.stringify(redactSensitive(entry.before)),
        entry.after === undefined ? null : JSON.stringify(redactSensitive(entry.after)),
        entry.metadata == null ? null : JSON.stringify(redactSensitive(entry.metadata)),
      ],
    );
  } catch (err: any) {
    console.error('[crm audit] failed to record audit row:', err?.message || err);
  }
}
