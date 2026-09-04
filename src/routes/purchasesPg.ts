import { Request, Response } from 'express';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { requirePgTenantAuth } from '../middleware/authPg';
import { apiToColumns, rowToApi, placeholders } from '../db/mapping';
import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/purchases.ts`.
 *
 * Base CRUD is the generic PG factory. The Mongo `purchases` doc embedded an
 * `items[]` array (dropped by the initial PG schema, recreated as the child
 * table `purchase_items` in migration 007).
 *
 * Three extra endpoints match the Mongo route:
 *   PATCH /:id/approve   (owner)            -> status = 'Approved'
 *   PATCH /:id/reject    (owner)            -> status = 'Rejected'
 *   POST  /:id/receive   (owner, operator)  -> mark an Order 'Received' and
 *                                              clone it into a completed Entry
 */

const PURCHASE_CHILD = {
  key: 'items',
  table: 'purchase_items',
  parentFk: 'purchase_id',
  orderBy: 'id ASC',
} as const;

const router = buildPgCrudRouter('purchases', {
  resourceName: 'Purchase',
  idType: 'uuid',
  children: [PURCHASE_CHILD],
});

/** Attach the `items` child rows to a purchase row, like the CRUD factory does. */
async function serializePurchase(row: any): Promise<any> {
  const obj = rowToApi<any>(row)!;
  const { rows } = await pgPool.query(
    `SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id ASC`,
    [String(row.id)]
  );
  obj.items = rows.map((r) => rowToApi(r));
  return obj;
}

router.patch(
  '/:id/approve',
  requirePgTenantAuth(['owner']),
  async (req: Request, res: Response) => {
    try {
      const { rows } = await pgPool.query(
        `UPDATE purchases
            SET status = 'Approved',
                approved_by = $1,
                approved_at = NOW(),
                rejection_reason = '',
                updated_at = NOW()
          WHERE shop_id = $2 AND id = $3
        RETURNING *`,
        [req.tenantAuth!.username, req.pgTenant!.shopId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase not found' });
      res.json(await serializePurchase(rows[0]));
    } catch (err: any) {
      console.error('[PATCH /purchases/:id/approve] failed:', err?.message || err);
      res.status(400).json({ error: err?.message || 'Failed to approve purchase' });
    }
  }
);

router.patch(
  '/:id/reject',
  requirePgTenantAuth(['owner']),
  async (req: Request, res: Response) => {
    try {
      const { rows } = await pgPool.query(
        `UPDATE purchases
            SET status = 'Rejected',
                approved_by = $1,
                approved_at = NOW(),
                rejection_reason = $2,
                updated_at = NOW()
          WHERE shop_id = $3 AND id = $4
        RETURNING *`,
        [req.tenantAuth!.username, req.body?.reason || '', req.pgTenant!.shopId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase not found' });
      res.json(await serializePurchase(rows[0]));
    } catch (err: any) {
      console.error('[PATCH /purchases/:id/reject] failed:', err?.message || err);
      res.status(400).json({ error: err?.message || 'Failed to reject purchase' });
    }
  }
);

router.post(
  '/:id/receive',
  requirePgTenantAuth(['owner', 'operator']),
  async (req: Request, res: Response) => {
    const shopId = req.pgTenant!.shopId;
    try {
      const entry = await withTransaction(async (client) => {
        const orderRes = await client.query(
          `SELECT * FROM purchases WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, req.params.id]
        );
        if (orderRes.rows.length === 0) {
          throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });
        }
        const order = orderRes.rows[0];

        if (order.doc_type !== 'Order') {
          throw Object.assign(new Error('Only Purchase Orders can be received'), { statusCode: 400 });
        }
        if (order.status !== 'Approved') {
          throw Object.assign(
            new Error('Purchase Order must be Approved before it can be received'),
            { statusCode: 400 }
          );
        }

        await client.query(
          `UPDATE purchases SET status = 'Received', updated_at = NOW() WHERE id = $1`,
          [order.id]
        );

        // Clone the order into a completed Entry.
        const source = rowToApi<any>(order)!;
        delete source.id;
        delete source._id;
        delete source.createdAt;
        delete source.updatedAt;

        const { columns, values } = await apiToColumns('purchases', source, {
          shop_id: shopId,
          doc_type: 'Entry',
          status: 'Completed',
          needs_approval: false,
          linked_doc_id: String(order.id),
        });
        const inserted = await client.query(
          `INSERT INTO purchases (${columns.join(', ')})
           VALUES (${placeholders(values.length)}) RETURNING *`,
          values
        );
        const newRow = inserted.rows[0];

        // Copy the order's line items onto the new entry.
        const itemsRes = await client.query(
          `SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id ASC`,
          [String(order.id)]
        );
        for (const it of itemsRes.rows) {
          const itemBody = rowToApi<any>(it)!;
          delete itemBody.id;
          delete itemBody._id;
          delete itemBody.purchaseId;
          const child = await apiToColumns('purchase_items', itemBody, {
            purchase_id: String(newRow.id),
          });
          if (child.columns.length === 0) continue;
          await client.query(
            `INSERT INTO purchase_items (${child.columns.join(', ')})
             VALUES (${placeholders(child.values.length)})`,
            child.values
          );
        }

        return newRow;
      });

      res.status(201).json(await serializePurchase(entry));
    } catch (err: any) {
      console.error('[POST /purchases/:id/receive] failed:', err?.message || err);
      res
        .status(err?.statusCode || 400)
        .json({ error: err?.message || 'Failed to receive purchase order' });
    }
  }
);

export default router;
