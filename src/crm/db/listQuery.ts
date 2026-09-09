/**
 * Safe list-query parsing for CRM endpoints: pagination, sorting, filtering
 * and search — with strict allow-lists so nothing user-supplied ever reaches
 * SQL as an identifier or operator.
 *
 * This is CRM-only infrastructure. It does NOT modify the existing ERP CRUD
 * factory (src/db/crud.ts), whose response shapes must stay unchanged.
 *
 * Design rules:
 *   - column names come ONLY from the route's allow-list (never from input);
 *   - sort direction is 'ASC' | 'DESC' only;
 *   - values are always passed as bound parameters ($1, $2, ...);
 *   - shop scoping is the caller's responsibility and must use the verified
 *     shop id from req.pgTenant (see assertNoClientShopScope()).
 */

export type SortDirection = 'ASC' | 'DESC';

export interface ListQueryConfig {
  /** Columns a client may sort by (raw column names). */
  sortable: string[];
  defaultSort: { column: string; direction: SortDirection };
  /** Columns a client may filter by equality (raw column names). */
  filterable?: string[];
  /** Columns searched by `?q=` with ILIKE. */
  searchable?: string[];
  maxLimit?: number;
  defaultLimit?: number;
}

export interface BuildWhereArgs {
  baseConditions: string[];
  baseParams: unknown[];
}

export interface ParsedListQuery {
  page: number;
  limit: number;
  offset: number;
  orderBy: { column: string; direction: SortDirection };
  buildWhere: (args: BuildWhereArgs) => { text: string; params: unknown[] };
}

const DIRECTIONS = new Set<SortDirection>(['ASC', 'DESC']);

function toInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse an Express `req.query` into a validated list query. Never throws on
 * bad input — it falls back to safe defaults (invalid sort column -> default
 * sort; unknown filter keys -> ignored).
 */
export function parseListQuery(
  query: Record<string, unknown>,
  config: ListQueryConfig,
): ParsedListQuery {
  const maxLimit = config.maxLimit ?? 100;
  const defaultLimit = config.defaultLimit ?? 25;

  const page = Math.max(1, toInt(query.page, 1));
  let limit = toInt(query.limit, defaultLimit);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  const offset = (page - 1) * limit;

  // --- sort ---
  const rawSort = String(query.sort ?? query.sortBy ?? '').trim();
  const rawDir = String(query.dir ?? query.order ?? '').trim().toUpperCase();
  let orderBy = { ...config.defaultSort };
  if (rawSort && config.sortable.includes(rawSort)) {
    orderBy = {
      column: rawSort,
      direction: DIRECTIONS.has(rawDir as SortDirection)
        ? (rawDir as SortDirection)
        : config.defaultSort.direction,
    };
  }

  // --- filters (equality, allow-listed columns only) ---
  const filterPairs: Array<{ column: string; value: string }> = [];
  const filterable = config.filterable ?? [];
  const rawFilter = query.filter;
  if (rawFilter && typeof rawFilter === 'object') {
    for (const [key, val] of Object.entries(rawFilter as Record<string, unknown>)) {
      if (filterable.includes(key) && val != null && String(val).length > 0) {
        filterPairs.push({ column: key, value: String(val) });
      }
    }
  }
  // Also accept bare allow-listed query keys (e.g. ?status=open).
  for (const col of filterable) {
    if (col in query && filterPairs.every((f) => f.column !== col)) {
      const val = query[col];
      if (val != null && String(val).length > 0) {
        filterPairs.push({ column: col, value: String(val) });
      }
    }
  }

  // --- search ---
  const searchTerm = String(query.q ?? '').trim();
  const searchable = config.searchable ?? [];

  const buildWhere = ({ baseConditions, baseParams }: BuildWhereArgs) => {
    const conditions = [...baseConditions];
    const params = [...baseParams];
    for (const { column, value } of filterPairs) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
    if (searchTerm && searchable.length > 0) {
      params.push(`%${escapeLike(searchTerm)}%`);
      const idx = params.length;
      const ors = searchable.map((col) => `${col} ILIKE $${idx}`);
      conditions.push(`(${ors.join(' OR ')})`);
    }
    const text = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { text, params };
  };

  return { page, limit, offset, orderBy, buildWhere };
}

/** Escape LIKE/ILIKE metacharacters in a user search term. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Guard: CRM handlers must never read shop_id from the request. Call this
 * with the request body/query to assert no client-supplied shop id is being
 * honoured. It only inspects — it never mutates.
 */
export function assertNoClientShopScope(input: Record<string, unknown> | null | undefined): void {
  if (!input) return;
  for (const key of ['shopId', 'shop_id', 'tenantId', 'tenant_id']) {
    if (key in input) {
      throw new Error(
        `[CRM] refused: request supplied "${key}" — shop scope must come from the verified JWT only`,
      );
    }
  }
}
