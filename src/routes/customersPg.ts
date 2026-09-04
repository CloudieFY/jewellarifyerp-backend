import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { generateId } from '../utils/id';
import { requirePgTenantAuth } from '../middleware/authPg';
import { apiToColumns, rowToApi, rowsToApi, placeholders } from '../db/mapping';
import { getTableMeta } from '../db/columns';

/**
 * PostgreSQL port of `routes/customers.ts`.
 * Every query is scoped to `req.pgTenant.shopId` (from the verified JWT).
 */

const router = Router();
const WRITE_ROLES: Array<'owner' | 'operator'> = ['owner', 'operator'];

router.get('/', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM customers WHERE shop_id = $1 ORDER BY name ASC`,
      [req.pgTenant!.shopId]
    );
    res.json(rowsToApi(rows));
  } catch (err: any) {
    console.error('[GET /customers] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

router.get('/:id', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM customers WHERE shop_id = $1 AND id = $2`,
      [req.pgTenant!.shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json(rowToApi(rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

router.post('/', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Customer name is required' });

    if (phone) {
      const dup = await pgPool.query(
        `SELECT 1 FROM customers WHERE shop_id = $1 AND phone = $2 LIMIT 1`,
        [shopId, phone]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'A customer with this phone number already exists.' });
      }
    }

    const { columns, values } = await apiToColumns('customers', req.body, {
      shop_id: shopId,
      id: generateId('cust'),
    });
    const { rows } = await pgPool.query(
      `INSERT INTO customers (${columns.join(', ')}) VALUES (${placeholders(values.length)}) RETURNING *`,
      values
    );
    res.status(201).json(rowToApi(rows[0]));
  } catch (err: any) {
    console.error('[POST /customers] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create customer' });
  }
});

router.put('/:id', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { columns, values } = await apiToColumns('customers', req.body);
    if (columns.length === 0) {
      const { rows } = await pgPool.query(
        `SELECT * FROM customers WHERE shop_id = $1 AND id = $2`,
        [shopId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
      return res.json(rowToApi(rows[0]));
    }
    const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await pgPool.query(
      `UPDATE customers SET ${setClause}, updated_at = NOW()
        WHERE shop_id = $${columns.length + 1} AND id = $${columns.length + 2}
        RETURNING *`,
      [...values, shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json(rowToApi(rows[0]));
  } catch (err: any) {
    console.error('[PUT /customers/:id] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to update customer' });
  }
});

/** DELETE FROM `table` WHERE shop_id = $1 AND `col` = $2 — only if the table actually has both columns. */
async function cascadeDelete(
  client: PoolClient,
  table: string,
  col: string,
  shopId: string,
  value: string
): Promise<void> {
  const meta = await getTableMeta(table);
  if (!meta.columns.has('shop_id') || !meta.columns.has(col)) return;
  await client.query(`DELETE FROM ${table} WHERE shop_id = $1 AND ${col} = $2`, [shopId, value]);
}

router.delete('/:id', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const id = req.params.id;

    const done = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT * FROM customers WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [shopId, id]
      );
      if (found.rows.length === 0) return false;
      const phone = found.rows[0].phone as string | null;

      for (const table of ['invoices', 'orders', 'repairs', 'girvi', 'advances']) {
        await cascadeDelete(client, table, 'customer_id', shopId, id);
        if (phone) await cascadeDelete(client, table, 'customer_mobile', shopId, phone);
      }

      await client.query(`DELETE FROM customers WHERE shop_id = $1 AND id = $2`, [shopId, id]);
      return true;
    });

    if (!done) return res.status(404).json({ error: 'Customer not found' });
    res.json({ message: 'Customer and all associated data deleted successfully' });
  } catch (err: any) {
    console.error('[DELETE /customers/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete customer and their data' });
  }
});

export default router;
