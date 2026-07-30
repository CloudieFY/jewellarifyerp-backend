import jwt from 'jsonwebtoken';

/**
 * Two separate JWT secrets/token types are used on purpose:
 *  - Super Admin tokens (platform control plane - can create/manage shops)
 *  - Tenant User tokens (shop owner / operator / karigar - scoped to ONE shop)
 *
 * Using different secrets means a leaked/forged tenant token can never be
 * mistaken for a super-admin token, even if the payload shapes were similar.
 */

export interface SuperAdminTokenPayload {
  sub: string; // super admin _id
  username: string;
  type: 'superadmin';
}

export interface TenantTokenPayload {
  sub: string; // user _id (within the shop's own User collection)
  shopId: string; // the shop's _id in the master DB -> also the dbName suffix
  username: string;
  role: 'owner' | 'operator' | 'karigar';
  karigarRefId?: string;
  type: 'tenant';
}

function getSuperAdminSecret(): string {
  // Prefer JWT_SECRET; fall back to JWT_SUPERADMIN_SECRET if present.
  const secret = process.env.JWT_SECRET || process.env.JWT_SUPERADMIN_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in environment variables.');
  return secret;
}


function getTenantSecret(): string {
  const secret = process.env.JWT_TENANT_SECRET;
  if (!secret) throw new Error('JWT_TENANT_SECRET is not set in environment variables.');
  return secret;
}

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export function signSuperAdminToken(payload: Omit<SuperAdminTokenPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'superadmin' }, getSuperAdminSecret(), {
    expiresIn: EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifySuperAdminToken(token: string): SuperAdminTokenPayload {
  return jwt.verify(token, getSuperAdminSecret()) as SuperAdminTokenPayload;
}

export function signTenantToken(payload: Omit<TenantTokenPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'tenant' }, getTenantSecret(), {
    expiresIn: EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyTenantToken(token: string): TenantTokenPayload {
  return jwt.verify(token, getTenantSecret()) as TenantTokenPayload;
}
