import { types as pgTypes } from 'pg';
import { getTableMeta } from './columns';

/**
 * ---------------------------------------------------------------------------
 * PG <-> API field mapping
 * ---------------------------------------------------------------------------
 * The PostgreSQL schema is snake_case; the frontend contract is camelCase and
 * every record must expose BOTH `id` and `_id` (a lot of frontend code reads
 * `record._id` directly). node-pg returns `numeric` as a string and
 * `timestamptz` as a Date — we normalise both here so responses match what the
 * old Mongoose `toJSON()` produced.
 * ---------------------------------------------------------------------------
 */

// numeric / decimal -> JS number (OID 1700). Loaded when this module is first
// imported, which only happens from the PG server — the Mongo process is
// unaffected.
pgTypes.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function deepCamel(value: any): any {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[snakeToCamel(k)] = deepCamel(v);
    }
    return out;
  }
  return value;
}

/**
 * Convert a raw DB row into the object shape the frontend expects:
 * camelCase keys, Dates as ISO strings, and `_id` mirrored from `id`.
 */
export function rowToApi<T = any>(row: Record<string, any> | null | undefined): T | null {
  if (!row) return null;
  const out = deepCamel(row) as Record<string, any>;
  if (out.id !== undefined && out.id !== null) {
    out._id = String(out.id);
    out.id = String(out.id);
  }
  return out as T;
}

export function rowsToApi<T = any>(rows: Array<Record<string, any>>): T[] {
  return rows.map((r) => rowToApi<T>(r) as T);
}

/**
 * Build the column/value lists for an INSERT or UPDATE from an API-shaped
 * (camelCase) body, keeping only fields that map to a real column on `table`.
 *
 *  - `id` / `_id` are always dropped (ids are assigned by us or the DB).
 *  - `created_at` / `updated_at` are dropped (DB-managed).
 *  - jsonb columns are JSON.stringify-ed (node-pg would otherwise try to
 *    encode a JS array/object as a Postgres array literal).
 *  - `extra` is an optional map of already-snake_cased column -> value pairs
 *    to force in (e.g. shop_id, a generated id).
 */
export async function apiToColumns(
  table: string,
  body: Record<string, any>,
  extra: Record<string, any> = {}
): Promise<{ columns: string[]; values: any[] }> {
  const meta = await getTableMeta(table);
  const collected = new Map<string, any>();

  for (const [rawKey, rawVal] of Object.entries(body ?? {})) {
    if (rawVal === undefined) continue;
    const col = camelToSnake(rawKey);
    if (col === 'id' || col === '_id' || col === 'created_at' || col === 'updated_at') continue;
    if (!meta.columns.has(col)) continue;

    let val = rawVal;
    // The frontend often sends "" for an untouched optional field. Mongoose
    // treated that as "unset"; here it would violate a numeric type or a
    // CHECK constraint, so normalise it to NULL for those columns.
    if (val === '' && (meta.numericColumns.has(col) || meta.checkColumns.has(col))) {
      val = null;
    }
    collected.set(col, val);
  }

  for (const [col, val] of Object.entries(extra)) {
    if (val === undefined) continue;
    collected.set(col, val);
  }

  const columns: string[] = [];
  const values: any[] = [];
  for (const [col, val] of collected) {
    columns.push(col);
    values.push(meta.jsonColumns.has(col) && val !== null ? JSON.stringify(val) : val);
  }
  return { columns, values };
}

/** `$1, $2, ...` placeholder list of length `n`, starting at `start`. */
export function placeholders(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `$${start + i}`).join(', ');
}
