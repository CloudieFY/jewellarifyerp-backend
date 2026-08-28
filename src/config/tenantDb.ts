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
 * Connections are cached (keyed by dbName) so we don't reconnect on every
 * request. Because the backend runs against a small/shared Atlas cluster
 * (e.g. an M0 tier with a low total connection ceiling), the cache is kept
 * intentionally small via LRU eviction, pool sizes are kept conservative,
 * and concurrent cache misses for the same tenant are coalesced into a
 * single in-flight connection attempt (see inFlightConnections below).
 * ---------------------------------------------------------------------------
 */

interface CachedTenant {
  connection: mongoose.Connection;
  models: TenantModels;
  lastUsed: number;
}

const tenantCache = new Map<string, CachedTenant>();

// Connection attempts currently in progress, keyed by dbName. Ensures that
// concurrent requests for the same not-yet-cached tenant all await the same
// single createConnection() call instead of each starting their own.
const inFlightConnections = new Map<string, Promise<CachedTenant>>();

/**
 * Reads a non-negative integer from an env var, falling back to `fallback`
 * when the var is absent, non-numeric, or below `min`. `min` defaults to 0
 * (values like a minimum pool size of 0 are legitimate); pass a higher
 * `min` for settings where a smaller value would be pathological.
 */
function intFromEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// Conservative defaults appropriate for an Atlas M0/shared cluster, where
// the TOTAL connection ceiling (across all tenant + master connections) is
// low (roughly ~500 on M0). Each cached tenant connection can open up to
// maxPoolSize sockets, so keep both the per-tenant pool and the number of
// simultaneously cached tenants small. Override via env vars if your
// cluster tier and tenant count justify larger values.
const TENANT_MAX_POOL_SIZE = intFromEnv('MONGO_TENANT_MAX_POOL_SIZE', 5);
const TENANT_MIN_POOL_SIZE = intFromEnv('MONGO_TENANT_MIN_POOL_SIZE', 0);
// Max number of tenant connections held in the LRU cache. Production
// deployments SHOULD set MONGO_MAX_CACHED_TENANT_CONNECTIONS explicitly to
// match their Atlas tier and expected concurrent-tenant count (recommended
// starting point: MONGO_MAX_CACHED_TENANT_CONNECTIONS=15). The value is
// clamped to a minimum of 1 — a cap of 0 is rejected because it would make
// every request connect then immediately evict, thrashing connections.
const MAX_CACHED_CONNECTIONS = intFromEnv('MONGO_MAX_CACHED_TENANT_CONNECTIONS', 15, 1);

export function dbNameForShop(slug: string): string {
  return `shop_${slug.replace(/-/g, '_')}`;
}

/** True if a cached connection is in a state where it's safe to keep using it. */
function isConnectionHealthy(connection: mongoose.Connection): boolean {
  // 1 = connected. 2 = connecting (a fresh connection briefly in-flight
  // before 'open' fires) is never stored in the cache by this module, so a
  // cached entry should only ever be 1 (healthy) or 0/3 (disconnected /
  // disconnecting -> stale, must be recreated).
  return connection.readyState === 1;
}

async function closeConnectionSafely(connection: mongoose.Connection, dbName: string, reason: string): Promise<void> {
  try {
    await connection.close();
    console.log(`[Tenant DB:${dbName}] connection closed (${reason}).`);
  } catch (err) {
    console.error(`[Tenant DB:${dbName}] error closing connection (${reason}):`, err);
  }
}

/**
 * Evicts the least-recently-used cached tenant connection if the cache is
 * at capacity. Never evicts a tenant that currently has a connection
 * attempt in flight (it isn't in tenantCache yet anyway, so it's naturally
 * excluded), and never evicts the entry we're about to insert for
 * `excludeDbName` (relevant if it was somehow already cached).
 */
function evictLruIfNeeded(excludeDbName: string): void {
  if (tenantCache.size < MAX_CACHED_CONNECTIONS) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, value] of tenantCache.entries()) {
    if (key === excludeDbName) continue;
    if (value.lastUsed < oldestTime) {
      oldestTime = value.lastUsed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const entry = tenantCache.get(oldestKey);
    tenantCache.delete(oldestKey);
    if (entry) {
      console.log(`[Tenant DB] evicting LRU connection -> ${oldestKey} (cache size ${tenantCache.size + 1}/${MAX_CACHED_CONNECTIONS})`);
      void closeConnectionSafely(entry.connection, oldestKey, 'LRU eviction');
    }
  }
}

async function createTenantConnection(dbName: string): Promise<CachedTenant> {
  const uri = buildDbUri(dbName);

  const connection = mongoose.createConnection(uri, {
    maxPoolSize: TENANT_MAX_POOL_SIZE,
    minPoolSize: TENANT_MIN_POOL_SIZE,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
  });

  try {
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
  } catch (err) {
    // Connection failed to open — make sure we don't leak a half-open
    // handle, and never let a failed connection reach the cache.
    await closeConnectionSafely(connection, dbName, 'failed to open');
    throw err;
  }

  connection.on('disconnected', () => {
    console.warn(`[Tenant DB:${dbName}] disconnected.`);
  });
  connection.on('error', (err) => {
    console.error(`[Tenant DB:${dbName}] connection error:`, err);
  });

  let models: TenantModels;
  try {
    models = registerTenantModels(connection);
  } catch (err) {
    // Model registration failed after the socket opened — close the
    // connection so we don't leak it, and let the original error propagate.
    // The caller's .finally() clears the in-flight entry and nothing is
    // ever cached.
    await closeConnectionSafely(connection, dbName, 'model registration failed');
    throw err;
  }

  console.log(`[Tenant DB] connected -> ${dbName} (cache size ${tenantCache.size + 1}/${MAX_CACHED_CONNECTIONS})`);

  return { connection, models, lastUsed: Date.now() };
}

/**
 * Returns a cached (or freshly created) connection + models for a given
 * shopId. This is the function every tenant-scoped route handler calls
 * to get access to that shop's isolated data.
 *
 * Concurrent calls for the same dbName that miss the cache are coalesced:
 * only one mongoose.createConnection() is started, and every caller awaits
 * that same promise.
 */
export async function getTenantContext(dbName: string): Promise<TenantModels> {
  if (!dbName || typeof dbName !== 'string') {
    throw new Error('A valid dbName is required to access tenant data.');
  }

  const existing = tenantCache.get(dbName);
  if (existing) {
    if (isConnectionHealthy(existing.connection)) {
      existing.lastUsed = Date.now();
      return existing.models;
    }
    // Stale/broken cached connection: remove it and fall through to create
    // a fresh one. Close it in the background rather than making the
    // current caller wait for its (already broken) close to resolve.
    tenantCache.delete(dbName);
    console.warn(`[Tenant DB:${dbName}] cached connection unhealthy (readyState=${existing.connection.readyState}), recreating.`);
    void closeConnectionSafely(existing.connection, dbName, 'stale/unhealthy');
  }

  const inFlight = inFlightConnections.get(dbName);
  if (inFlight) {
    const cached = await inFlight;
    return cached.models;
  }

  const connectionPromise = createTenantConnection(dbName)
    .then((cached) => {
      evictLruIfNeeded(dbName);
      tenantCache.set(dbName, cached);
      return cached;
    })
    .finally(() => {
      inFlightConnections.delete(dbName);
    });

  inFlightConnections.set(dbName, connectionPromise);

  const cached = await connectionPromise;
  return cached.models;
}

/**
 * Closes and removes a tenant's cached connection. Useful if a shop is
 * deleted/suspended and you want to free up the connection immediately
 * rather than waiting for natural eviction.
 */
export async function closeTenantConnection(dbName: string): Promise<void> {
  // If a connection attempt is in flight, wait for it so we don't close a
  // connection that's still being handed to concurrent callers, then close
  // whatever ended up cached.
  const inFlight = inFlightConnections.get(dbName);
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // createTenantConnection already cleaned up on failure; nothing cached.
    }
  }

  const existing = tenantCache.get(dbName);
  if (existing) {
    tenantCache.delete(dbName);
    await closeConnectionSafely(existing.connection, dbName, 'explicit close');
  }
}

export function getCachedTenantCount(): number {
  return tenantCache.size;
}

/**
 * Safe diagnostics snapshot for troubleshooting connection issues. Does not
 * expose credentials or full connection URIs — only database names (which
 * are already non-sensitive tenant identifiers used throughout the app)
 * and connection state.
 */
export function getTenantConnectionStats(): {
  cachedCount: number;
  maxCachedConnections: number;
  inFlightCount: number;
  tenants: Array<{ dbName: string; readyState: number; lastUsed: number }>;
} {
  const tenants = Array.from(tenantCache.entries()).map(([dbName, entry]) => ({
    dbName,
    readyState: entry.connection.readyState,
    lastUsed: entry.lastUsed,
  }));

  return {
    cachedCount: tenantCache.size,
    maxCachedConnections: MAX_CACHED_CONNECTIONS,
    inFlightCount: inFlightConnections.size,
    tenants,
  };
}

/**
 * Closes every cached tenant connection. Intended for use during graceful
 * process shutdown (SIGTERM/SIGINT) so no sockets are left open when the
 * process exits.
 */
export async function closeAllTenantConnections(): Promise<void> {
  const entries = Array.from(tenantCache.entries());
  tenantCache.clear();
  await Promise.all(
    entries.map(([dbName, entry]) => closeConnectionSafely(entry.connection, dbName, 'shutdown'))
  );
}
