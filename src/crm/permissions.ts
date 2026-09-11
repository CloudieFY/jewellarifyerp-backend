/**
 * CRM permission catalogue + role → permission resolution.
 *
 * This is the SINGLE source of truth for CRM authorization. Backend routes
 * enforce permissions via `requireCrmPermission()` (see
 * ./middleware/requireCrmPermission.ts). The frontend has a mirror of the
 * check logic for UX only — it is never trusted for security.
 *
 * Permission string shape:  `<entity>.<action>`  e.g. `lead.view`.
 * Wildcards understood by `can()`:  `*`  (everything) and  `<entity>.*`.
 */

/* ------------------------------------------------------------------ */
/* Entities + actions                                                  */
/* ------------------------------------------------------------------ */
export const CRM_PERMISSION_CATALOG = {
  lead: ['view', 'create', 'update', 'delete', 'assign', 'qualify', 'convert', 'export'],
  opportunity: ['view', 'create', 'update', 'delete', 'assign', 'stage', 'win', 'lose', 'export'],
  task: ['view', 'create', 'update', 'delete', 'assign', 'complete'],
  demo: ['view', 'create', 'update', 'delete', 'assign', 'complete'],
  quotation: ['view', 'create', 'update', 'delete', 'send', 'accept', 'export'],
  payment: ['view', 'create', 'update', 'reconcile', 'export'],
  installation: ['view', 'create', 'update', 'assign', 'complete'],
  ticket: ['view', 'create', 'update', 'assign', 'resolve', 'export'],
  customer: ['view', 'update', 'export'],
  segment: ['view', 'manage'],
  referral: ['view', 'create', 'update'],
  campaign: ['view', 'manage'],
  message: ['view', 'send'],
  notification: ['view'],
  audit: ['view'],
  report: ['view'],
  branch: ['view', 'manage'],
  settings: ['manage'],
  automation: ['manage'],
} as const;

export type CrmEntity = keyof typeof CRM_PERMISSION_CATALOG;

/** Every valid `<entity>.<action>` string. */
export const ALL_CRM_PERMISSIONS: readonly string[] = Object.freeze(
  Object.entries(CRM_PERMISSION_CATALOG).flatMap(([entity, actions]) =>
    (actions as readonly string[]).map((a) => `${entity}.${a}`),
  ),
);
const ALL_CRM_PERMISSIONS_SET = new Set(ALL_CRM_PERMISSIONS);

export function isValidCrmPermission(p: string): boolean {
  return ALL_CRM_PERMISSIONS_SET.has(p);
}

/** A string that may appear in `users.permissions`: a catalogue entry or `<entity>.*`. */
export function isGrantablePermission(p: string): boolean {
  if (p === '*') return true;
  if (isValidCrmPermission(p)) return true;
  return p.endsWith('.*') && p.slice(0, -2) in CRM_PERMISSION_CATALOG;
}

/**
 * Validate a proposed `users.permissions` array. Returns the cleaned list on
 * success (trimmed, de-duplicated) or the list of invalid entries.
 */
export function validatePermissionGrants(
  input: unknown,
): { ok: true; value: string[] } | { ok: false; invalid: string[] } {
  if (!Array.isArray(input)) return { ok: false, invalid: ['<not an array>'] };
  const cleaned: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (isGrantablePermission(p)) {
      if (!cleaned.includes(p)) cleaned.push(p);
    } else {
      invalid.push(p);
    }
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, value: cleaned };
}

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */
export const CRM_ROLES = [
  'crm_admin',
  'sales_exec',
  'demo_exec',
  'accounting',
  'support',
  'dealer',
] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export function isValidCrmRole(r: unknown): r is CrmRole {
  return typeof r === 'string' && (CRM_ROLES as readonly string[]).includes(r);
}

const perms = (...list: string[]): string[] => list;

/**
 * Role → granted permissions. `['*']` means "all CRM permissions".
 * These are deliberately conservative; extra grants go on
 * `users.permissions` (additive).
 */
export const ROLE_PERMISSIONS: Record<CrmRole, string[]> = {
  crm_admin: ['*'],
  sales_exec: perms(
    'lead.view', 'lead.create', 'lead.update', 'lead.assign', 'lead.qualify', 'lead.convert', 'lead.export',
    'opportunity.view', 'opportunity.create', 'opportunity.update', 'opportunity.assign', 'opportunity.stage',
    'opportunity.win', 'opportunity.lose', 'opportunity.export',
    'task.view', 'task.create', 'task.update', 'task.complete',
    'demo.view', 'demo.create',
    'quotation.view', 'quotation.create', 'quotation.update', 'quotation.send',
    'payment.view',
    'customer.view', 'customer.update',
    'segment.view', 'referral.view', 'referral.create',
    'message.view', 'message.send', 'notification.view', 'report.view', 'branch.view',
  ),
  demo_exec: perms(
    'lead.view', 'opportunity.view',
    'task.view', 'task.create', 'task.update', 'task.complete',
    'demo.view', 'demo.create', 'demo.update', 'demo.assign', 'demo.complete',
    'customer.view', 'notification.view', 'branch.view',
  ),
  accounting: perms(
    'opportunity.view',
    'quotation.view', 'quotation.accept', 'quotation.export',
    'payment.view', 'payment.create', 'payment.update', 'payment.reconcile', 'payment.export',
    'installation.view',
    'customer.view', 'report.view', 'notification.view', 'branch.view',
  ),
  support: perms(
    'ticket.view', 'ticket.create', 'ticket.update', 'ticket.assign', 'ticket.resolve', 'ticket.export',
    'task.view', 'task.create', 'task.update', 'task.complete',
    'installation.view', 'installation.update',
    'customer.view', 'notification.view', 'report.view', 'branch.view',
  ),
  dealer: perms('lead.view', 'lead.create', 'referral.view', 'referral.create', 'notification.view'),
};

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */
/**
 * CRM is Super-Admin-primary (Phase 0 revision): no ERP role gets CRM access
 * implicitly. Access is granted only via an explicit `crm_role` or explicit
 * `permissions` entries on the user row.
 */

export interface PermissionSubject {
  role?: string | null;
  crm_role?: string | null;
  crmRole?: string | null;
  permissions?: string[] | null;
}

/**
 * Resolve the effective CRM permission set for a user. Returns a Set of
 * permission strings; may contain the `*` wildcard or `<entity>.*` wildcards.
 */
export function resolveUserPermissions(subject: PermissionSubject | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!subject) return out;

  const crmRole = subject.crm_role ?? subject.crmRole ?? '';

  if (isValidCrmRole(crmRole)) {
    ROLE_PERMISSIONS[crmRole].forEach((p) => out.add(p));
  }

  for (const raw of subject.permissions ?? []) {
    const p = String(raw).trim();
    if (!p) continue;
    // Accept exact catalogue entries and `<entity>.*` wildcards only.
    if (p === '*' || isValidCrmPermission(p)) {
      out.add(p);
    } else if (p.endsWith('.*') && p.slice(0, -2) in CRM_PERMISSION_CATALOG) {
      out.add(p);
    }
  }
  return out;
}

/** Does this resolved permission set satisfy `<entity>.<action>`? */
export function can(granted: Set<string> | string[], entity: string, action: string): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return set.has('*') || set.has(`${entity}.*`) || set.has(`${entity}.${action}`);
}

/** True if the subject has ANY CRM permission at all (used to show the CRM area). */
export function hasAnyCrmAccess(subject: PermissionSubject | null | undefined): boolean {
  return resolveUserPermissions(subject).size > 0;
}

/** Expand wildcards into the concrete permission list (handy for API responses/tests). */
export function expandPermissions(granted: Set<string> | string[]): string[] {
  const set = granted instanceof Set ? granted : new Set(granted);
  if (set.has('*')) return [...ALL_CRM_PERMISSIONS];
  const out = new Set<string>();
  for (const p of set) {
    if (p.endsWith('.*')) {
      const entity = p.slice(0, -2);
      for (const perm of ALL_CRM_PERMISSIONS) {
        if (perm.startsWith(`${entity}.`)) out.add(perm);
      }
    } else if (isValidCrmPermission(p)) {
      out.add(p);
    }
  }
  return [...out].sort();
}
