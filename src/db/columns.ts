import { pgPool } from '../config/postgres';

/**
 * Per-table column metadata, loaded once from the catalog and cached for the
 * life of the process. Used by the PG CRUD layer to:
 *   - whitelist incoming request-body fields against real columns
 *   - know which columns are jsonb (must be JSON.stringify-ed before bind)
 *   - know which columns are numeric or CHECK-constrained, so an empty string
 *     from the frontend can be coerced to NULL instead of blowing up
 */
export interface TableMeta {
  /** Every column name on the table. */
  columns: Set<string>;
  /** Subset of `columns` whose type is json/jsonb. */
  jsonColumns: Set<string>;
  /** Subset of `columns` with a numeric/integer/double type. */
  numericColumns: Set<string>;
  /** Subset of `columns` referenced by a CHECK constraint. */
  checkColumns: Set<string>;
  /** True when the table physically has a `shop_id` column. */
  hasShopId: boolean;
}

const NUMERIC_TYPES = new Set([
  'numeric', 'decimal', 'real', 'double precision',
  'integer', 'bigint', 'smallint',
]);

const cache = new Map<string, Promise<TableMeta>>();

export function getTableMeta(table: string): Promise<TableMeta> {
  let entry = cache.get(table);
  if (!entry) {
    entry = load(table);
    cache.set(table, entry);
  }
  return entry;
}

async function load(table: string): Promise<TableMeta> {
  const { rows } = await pgPool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );

  if (rows.length === 0) {
    throw new Error(`Unknown table "${table}" (no columns found in information_schema)`);
  }

  const columns = new Set<string>();
  const jsonColumns = new Set<string>();
  const numericColumns = new Set<string>();
  for (const r of rows) {
    columns.add(r.column_name);
    if (r.data_type === 'jsonb' || r.data_type === 'json') jsonColumns.add(r.column_name);
    if (NUMERIC_TYPES.has(r.data_type)) numericColumns.add(r.column_name);
  }

  const checkRes = await pgPool.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE n.nspname = 'public' AND rel.relname = $1 AND con.contype = 'c'`,
    [table]
  );
  const checkColumns = new Set(checkRes.rows.map((r) => r.attname));

  return { columns, jsonColumns, numericColumns, checkColumns, hasShopId: columns.has('shop_id') };
}
