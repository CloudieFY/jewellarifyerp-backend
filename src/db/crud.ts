import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { generateId } from '../utils/id';
import { requirePgTenantAuth } from '../middleware/authPg';
import { apiToColumns, rowToApi, placeholders } from './mapping';

type Role = 'owner' | 'operator' | 'karigar';

export interface ChildSpec {
  /** API key on the parent object, e.g. 'transactions', 'stones', 'items'. */
  key: string;
  /** Child table name. */
  table: string;
  /** Column on the child table that references the parent id. */
  parentFk: string;
  /** Child rows are ordered by this SQL fragment when read. */
  orderBy?: string;
  /** When set, the child id is `text` with no DB default — generate one per row with this prefix. */
  idPrefix?: string;
  /** Child table has a `shop_id` column that must be populated on insert. */
  withShopId?: boolean;
}

export interface PgCrudOptions {
  resourceName: string;
  /** Parent list ordering. Default: `created_at DESC`. */
  sortBy?: string;
  /** `text` -> we generate `generateId(idPrefix)`. `uuid` -> rely on the DB default. Default: `text`. */
  idType?: 'text' | 'uuid';
  idPrefix?: string;
  readRoles?: Role[];
  writeRoles?: Role[];
  children?: ChildSpec[];
  /** Mutate/normalise the incoming (camelCase) body before insert/update. */
  beforeWrite?: (body: any, req: Request) => any | Promise<any>;
  /** Final chance to shape the serialized object sent to the client. */
  afterSerialize?: (obj: any, row: any) => any;
  /** Extra cascade work inside the DELETE transaction, before the row is removed. */
  onDelete?: (client: PoolClient, id: string, row: any, shopId: string) => Promise<void>;
}

async function loadChildren(
  spec: ChildSpec,
  parentIds: string[]
): Promise<Map<string, any[]>> {
  const grouped = new Map<string, any[]>();
  if (parentIds.length === 0) return grouped;

  const order = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const { rows } = await pgPool.query(
    `SELECT * FROM ${spec.table} WHERE ${spec.parentFk} = ANY($1)${order}`,
    [parentIds]
  );
  for (const row of rows) {
    const pid = String(row[spec.parentFk]);
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid)!.push(rowToApi(row));
  }
  return grouped;
}

async function serializeRows(rows: any[], opts: PgCrudOptions): Promise<any[]> {
  const objs = rows.map((r) => rowToApi(r) as any);
  const children = opts.children ?? [];

  if (children.length && objs.length) {
    const ids = objs.map((o) => String(o.id));
    for (const spec of children) {
      const grouped = await loadChildren(spec, ids);
      for (const obj of objs) {
        obj[spec.key] = grouped.get(String(obj.id)) ?? [];
      }
    }
  } else {
    for (const obj of objs) {
      for (const spec of children) obj[spec.key] = [];
    }
  }

  if (opts.afterSerialize) {
    return objs.map((o, i) => opts.afterSerialize!(o, rows[i]));
  }
  return objs;
}

async function insertChildren(
  client: PoolClient,
  spec: ChildSpec,
  parentId: string,
  shopId: string,
  list: any[]
): Promise<void> {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const extra: Record<string, any> = { [spec.parentFk]: parentId };
    if (spec.withShopId) extra.shop_id = shopId;
    if (spec.idPrefix) extra.id = generateId(spec.idPrefix);
    const { columns, values } = await apiToColumns(spec.table, item, extra);
    if (columns.length === 0) continue;
    await client.query(
      `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders(values.length)})`,
      values
    );
  }
}

async function replaceChildren(
  client: PoolClient,
  spec: ChildSpec,
  parentId: string,
  shopId: string,
  list: any[]
): Promise<void> {
  await client.query(`DELETE FROM ${spec.table} WHERE ${spec.parentFk} = $1`, [parentId]);
  await insertChildren(client, spec, parentId, shopId, list);
}

/**
 * Builds a standard REST CRUD router (GET list, GET :id, POST, PUT :id,
 * DELETE :id) for a single PostgreSQL table, always scoped to the caller's
 * shop via `req.pgTenant.shopId` (which comes only from the verified JWT).
 *
 * The PG equivalent of `routes/crudFactory.ts::buildTenantCrudRouter`.
 */
export function buildPgCrudRouter(table: string, opts: PgCrudOptions): Router {
  const router = Router();
  const {
    resourceName,
    sortBy = 'created_at DESC',
    idType = 'text',
    idPrefix,
    readRoles,
    writeRoles = ['owner', 'operator'],
    children = [],
  } = opts;

  const runBeforeWrite = async (body: any, req: Request) =>
    opts.beforeWrite ? await opts.beforeWrite(body, req) : body;

  router.get('/', requirePgTenantAuth(readRoles), async (req: Request, res: Response) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT * FROM ${table} WHERE shop_id = $1 ORDER BY ${sortBy}`,
        [req.pgTenant!.shopId]
      );
      res.json(await serializeRows(rows, opts));
    } catch (err: any) {
      console.error(`[GET /${resourceName}] failed:`, err?.message || err);
      res.status(500).json({ error: `Failed to fetch ${resourceName}` });
    }
  });

  router.get('/:id', requirePgTenantAuth(readRoles), async (req: Request, res: Response) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT * FROM ${table} WHERE shop_id = $1 AND id = $2`,
        [req.pgTenant!.shopId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: `${resourceName} not found` });
      const [obj] = await serializeRows(rows, opts);
      res.json(obj);
    } catch (err: any) {
      console.error(`[GET /${resourceName}/:id] failed:`, err?.message || err);
      res.status(500).json({ error: `Failed to fetch ${resourceName}` });
    }
  });

  router.post('/', requirePgTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const shopId = req.pgTenant!.shopId;
      const body = await runBeforeWrite({ ...req.body }, req);

      const extra: Record<string, any> = { shop_id: shopId };
      if (idType === 'text') extra.id = generateId(idPrefix);

      const created = await withTransaction(async (client) => {
        const { columns, values } = await apiToColumns(table, body, extra);
        const { rows } = await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(values.length)}) RETURNING *`,
          values
        );
        const row = rows[0];
        for (const spec of children) {
          await insertChildren(client, spec, String(row.id), shopId, body[spec.key] ?? []);
        }
        return row;
      });

      const [obj] = await serializeRows([created], opts);
      res.status(201).json(obj);
    } catch (err: any) {
      console.error(`[POST /${resourceName}] failed:`, err?.message || err);
      res.status(400).json({ error: err?.message || `Failed to create ${resourceName}` });
    }
  });

  router.put('/:id', requirePgTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const shopId = req.pgTenant!.shopId;
      const id = req.params.id;
      const body = await runBeforeWrite({ ...req.body }, req);

      const updated = await withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT id FROM ${table} WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, id]
        );
        if (existing.rows.length === 0) return null;

        const { columns, values } = await apiToColumns(table, body);
        let row;
        if (columns.length > 0) {
          const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
          const result = await client.query(
            `UPDATE ${table} SET ${setClause}, updated_at = NOW()
              WHERE shop_id = $${columns.length + 1} AND id = $${columns.length + 2}
              RETURNING *`,
            [...values, shopId, id]
          );
          row = result.rows[0];
        } else {
          const result = await client.query(
            `SELECT * FROM ${table} WHERE shop_id = $1 AND id = $2`,
            [shopId, id]
          );
          row = result.rows[0];
        }

        for (const spec of children) {
          if (Object.prototype.hasOwnProperty.call(body, spec.key)) {
            await replaceChildren(client, spec, id, shopId, body[spec.key] ?? []);
          }
        }
        return row;
      });

      if (!updated) return res.status(404).json({ error: `${resourceName} not found` });
      const [obj] = await serializeRows([updated], opts);
      res.json(obj);
    } catch (err: any) {
      console.error(`[PUT /${resourceName}/:id] failed:`, err?.message || err);
      res.status(400).json({ error: err?.message || `Failed to update ${resourceName}` });
    }
  });

  router.delete('/:id', requirePgTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const shopId = req.pgTenant!.shopId;
      const id = req.params.id;

      const found = await withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT * FROM ${table} WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, id]
        );
        if (existing.rows.length === 0) return false;
        const row = existing.rows[0];

        if (opts.onDelete) await opts.onDelete(client, id, rowToApi(row), shopId);

        for (const spec of children) {
          await client.query(`DELETE FROM ${spec.table} WHERE ${spec.parentFk} = $1`, [id]);
        }
        await client.query(`DELETE FROM ${table} WHERE shop_id = $1 AND id = $2`, [shopId, id]);
        return true;
      });

      if (!found) return res.status(404).json({ error: `${resourceName} not found` });
      res.json({ message: `${resourceName} deleted` });
    } catch (err: any) {
      console.error(`[DELETE /${resourceName}/:id] failed:`, err?.message || err);
      res.status(500).json({ error: `Failed to delete ${resourceName}` });
    }
  });

  return router;
}
