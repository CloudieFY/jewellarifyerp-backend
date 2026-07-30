import mongoose from 'mongoose';
import 'dotenv/config';

/**
 * The MASTER connection holds platform-wide control-plane data:
 *   - SuperAdmin accounts
 *   - Shop registry (tenant directory: name, slug, db name, plan, status...)
 *
 * This is a single shared database, separate from every shop's own database.
 */

let masterConn: mongoose.Connection | null = null;

function getBaseUri(): string {
  const base = process.env.MONGODB_BASE_URI;
  if (!base) {
    throw new Error(
      'MONGODB_BASE_URI is not set. Add it to your .env file (see .env.example).'
    );
  }
  if (!base.startsWith('mongodb://') && !base.startsWith('mongodb+srv://')) {
    throw new Error(
      'MONGODB_BASE_URI must start with "mongodb://" or "mongodb+srv://".'
    );
  }
  // Strip a trailing slash if present, and strip any trailing db name/query
  // so we can safely append our own database name + options.
  // If the base URI already contains a DB name (e.g. .../someDb?retryWrites=...),
  // strip it, because buildDbUri() appends its own dbName segment.
  // Keep only: protocol + auth@host (and any query string).
  const url = new URL(base);
  // Set pathname to '/' to remove any existing database name from the path,
  // while preserving the hostname, port, auth, and query parameters.
  url.pathname = '/';
  const cleanedHost = url.toString().replace(/\/$/, ''); // convert back to string and remove trailing slash
  const [hostPart, queryPart] = cleanedHost.split('?');
  return queryPart ? `${cleanedHost}?${queryPart}` : cleanedHost;
}

export function getMasterDbName(): string {
  return process.env.MASTER_DB_NAME || 'jewelshop_master';
}

/**
 * Builds a full Mongo connection URI for a given database name, preserving
 * any query string options (like retryWrites=true&w=majority) that may be
 * present on the base Atlas URI.
 */
export function buildDbUri(dbName: string): string { 
  const base = getBaseUri();

  // Atlas SRV URIs look like: mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
  // We need to insert the dbName as the path segment, right after the host,
  // before the "?" query string (if any).
  const [hostPart, queryPart] = base.split('?');
  const trimmedHost = hostPart.replace(/\/$/, '');
  const uri = queryPart
    ? `${trimmedHost}/${dbName}?${queryPart}`
    : `${trimmedHost}/${dbName}`;
  return uri;
}

export async function connectMaster(): Promise<mongoose.Connection> {
  if (masterConn && masterConn.readyState === 1) {
    return masterConn;
  }

  const uri = buildDbUri(getMasterDbName());
  const conn = mongoose.createConnection(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  });

  await new Promise<void>((resolve, reject) => {
    conn.once('open', () => resolve());
    conn.once('error', (err) => reject(err));
  });

  conn.on('disconnected', () => {
    console.warn('[Master DB] disconnected. Mongoose will attempt to reconnect.');
  });
  conn.on('error', (err) => {
    console.error('[Master DB] connection error:', err);
  });

  console.log(`[Master DB] connected -> ${getMasterDbName()}`);
  masterConn = conn;
  return conn;
}

export function getMasterConnection(): mongoose.Connection {
  if (!masterConn) {
    throw new Error('Master DB connection has not been initialized yet. Call connectMaster() first.');
  }
  return masterConn;
}
