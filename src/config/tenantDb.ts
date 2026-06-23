import mongoose from 'mongoose';
import { buildDbUri } from './masterDb';
import { registerTenantModels, TenantModels } from '../models/tenant/registerTenantModels';

/**
 * ---------------------------------------------------------------------------
 * TENANT CONNECTION MANAGER
 * ---------------------------------------------------------------------------
 * This is the heart of the multi-tenancy system.
 *
 * Every shop ("tenant") gets its own PHYSICAL MongoDB database, e.g.:
 *    shop_64f1a2b3c4d5e6f7a8b9c0d1
 *
 * When a request comes in for a given shopId, we look up (or lazily create)
 * a cached Mongoose connection that points ONLY at that shop's database, and
 * we bind a fresh set of Models to that exact connection. Because Mongoose
 * models are connection-scoped, a model created on shop A's connection can
 * physically never read or write shop B's data — even if there were a bug
 * in route code, the underlying driver would be talking to a different
 * database entirely.
 *
 * Connections are cached (keyed by shopId) so we don't reconnect on every
 * request, and idle connections are not closed automatically here since
 * connection pooling in mongoose already manages socket usage efficiently;
 * for very large numbers of tenants you may want an LRU eviction policy —
 * see the comment near MAX_CACHED_CONNECTIONS below.
 * ---------------------------------------------------------------------------
 */

interface CachedTenant {
  connection: mongoose.Connection;
  models: TenantModels;
  lastUsed: number;
}

const tenantCache = new Map<string, CachedTenant>();

// Optional safety valve: if you have thousands of shops and worry about
// hitting connection limits, lower this and the oldest idle entries will be
// evicted. Atlas free/shared tiers allow several hundred connections; most
// small/medium SaaS deployments will never need to touch this.
const MAX_CACHED_CONNECTIONS = 500;
 
export function dbNameForShop(slug: string): string {
  return `shop_${slug.replace(/-/g, '_')}`;
}

function evictOldestIfNeeded() {
  if (tenantCache.size < MAX_CACHED_CONNECTIONS) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, value] of tenantCache.entries()) {
    if (value.lastUsed < oldestTime) {
      oldestTime = value.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = tenantCache.get(oldestKey);
    entry?.connection.close().catch(() => {});
    tenantCache.delete(oldestKey);
  }
}

/**
 * Returns a cached (or freshly created) connection + models for a given
 * shopId. This is the function every tenant-scoped route handler calls
 * to get access to that shop's isolated data.
 */
export async function getTenantContext(dbName: string): Promise<TenantModels> {
  if (!dbName || typeof dbName !== 'string') {
    throw new Error('A valid dbName is required to access tenant data.');
  }

  const existing = tenantCache.get(dbName);
  if (existing && existing.connection.readyState === 1) {
    existing.lastUsed = Date.now();
    return existing.models;
  }

  evictOldestIfNeeded();

  const uri = buildDbUri(dbName);

  const connection = mongoose.createConnection(uri, {
    // Increased timeout for slower networks. Default is 30000ms.
    // We were using 8000ms, which might be too short for initial DNS SRV lookups on some networks.
    serverSelectionTimeoutMS: 30000,
    // Keep sockets alive, which can help with intermittent connectivity.
    socketTimeoutMS: 45000,
  });

  await new Promise<void>((resolve, reject) => {
    connection.once('open', () => resolve());
    connection.once('error', (err) => {
      // Provide a more specific error message for common network issues.
      if (err.name === 'MongooseServerSelectionError' && err.message.includes('querySrv ETIMEOUT')) {
        reject(new Error(`DNS lookup for MongoDB timed out. Check your internet connection, firewall, or VPN settings.`));
      } else {
        reject(err);
      }
    });
  });

  connection.on('disconnected', () => {
    console.warn(`[Tenant DB:${dbName}] disconnected.`);
  });
  connection.on('error', (err) => {
    console.error(`[Tenant DB:${dbName}] connection error:`, err);
  });

  const models = registerTenantModels(connection);

  tenantCache.set(dbName, { connection, models, lastUsed: Date.now() });
  console.log(`[Tenant DB] connected -> ${dbName}`);

  return models;
}

/**
 * Closes and removes a tenant's cached connection. Useful if a shop is
 * deleted/suspended and you want to free up the connection immediately
 * rather than waiting for natural eviction.
 */
export async function closeTenantConnection(dbName: string): Promise<void> {
  const existing = tenantCache.get(dbName);
  if (existing) {
    await existing.connection.close();
    tenantCache.delete(dbName);
  }
}

export function getCachedTenantCount(): number {
  return tenantCache.size;
}
