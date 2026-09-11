/**
 * Shared helpers for the Super Admin CRM route layer
 * (mounted at /api/superadmin/crm by src/crm/routes/admin/index.ts).
 *
 * These routes are a THIN wrapper around the exact same engine the tenant
 * CRM routes use (src/crm/{leads,opportunities,tasks}/repository.ts,
 * src/crm/leads/service.ts, src/crm/audit/recordAudit.ts,
 * src/crm/outbox/repository.ts, src/crm/activity/repository.ts) — no
 * business logic is duplicated, only re-hosted behind Super Admin auth with
 * an explicit `:shopId` in place of the tenant JWT's implicit shop scope.
 *
 * `actor_user_id` on `crm_audit_log`/`crm_activity` is a nullable FK to
 * `users(id)` — a Super Admin's id lives in the separate `superadmins`
 * table and is NOT a valid `users.id`, so it must never be passed as
 * `actorUserId` (the insert would violate the FK). Instead every admin
 * action records `null` there and puts the real actor identity in
 * `metadata`/`data` via `adminActorMeta()`.
 */

import type { Request } from 'express';

export function adminActorMeta(req: Request): { actorSuperAdminId: string; actorSuperAdminUsername: string } {
  const sa = req.superAdmin!;
  return { actorSuperAdminId: sa.sub, actorSuperAdminUsername: sa.username };
}
