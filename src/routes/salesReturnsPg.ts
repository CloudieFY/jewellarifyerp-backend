import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { requirePgTenantAuth } from '../middleware/authPg';
import { apiToColumns, rowToApi, placeholders } from '../db/mapping';

/**
 * PostgreSQL port of `routes/sales-returns.ts`.
 *
 * `salesReturn.items` (embedded array in Mongo) is the child table
 * `sales_return_items`. Creating a return restores `inventory` stock & weights
 * and writes a `stock_ledger` RETURN row, then reduces the linked invoice's
 * (and, if refund is left over, the customer's other open invoices') dues -
 * all inside one transaction, same as the Mongo route.
 *
 * Faithful-port note: the Mongo route's DELETE handler only reverses the dues
 * adjustment and clears `invoice.isReturned`; it does NOT re-deduct the
 * restored stock (the `deductInventoryFromSalesReturnReversal` helper there is
 * dead code). This port keeps that behaviour.
 */

const router = Router();
const WRITE_ROLES: Array<'owner' | 'operator'> = ['owner', 'operator'];

const round3 = (n: number) => Number((Number(n) || 0).toFixed(3));

/* ------------------------------------------------------------------ */
/* productId helpers - ported verbatim from routes/sales-returns.ts    */
/* ------------------------------------------------------------------ */

function isManualOrNonInventoryId(productId: string): boolean {
  if (!productId || typeof productId !== 'string') return true;
  const lower = productId.toLowerCase().trim();
  return (
    lower === '' ||
    lower.startsWith('manual') ||
    lower.startsWith('linked') ||
    lower.startsWith('custom') ||
    lower === 'none' ||
    lower === 'null'
  );
}

function normalizeProductId(productId: string): string {
  if (!productId || typeof productId !== 'string') return productId;
  if (isManualOrNonInventoryId(productId)) return productId;
  if (productId.includes('__GW_')) return productId.split('__GW_')[0];
  return productId;
}

function parseGrossWeightFromProductId(productId: string): number {
  if (!productId || !productId.includes('__GW_')) return 0;
  try {
    const afterGW = productId.split('__GW_')[1];
    const gwStr = afterGW ? afterGW.split('__SW_')[0] : '0';
    return Number(gwStr) || 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Inventory + stock ledger                                            */
/* ------------------------------------------------------------------ */

async function resolveInventory(
  client: PoolClient,
  shopId: string,
  productId: string,
  itemName?: string
): Promise<any | null> {
  const raw = productId || '';
  if (isManualOrNonInventoryId(raw)) return null;
  const normalized = normalizeProductId(raw);
  if (isManualOrNonInventoryId(normalized)) return null;

  const { rows } = await client.query(
    `SELECT * FROM inventory
      WHERE shop_id = $1
        AND (id::text = $2 OR barcode = $2 OR huid = $2 OR item_code = $2)
      LIMIT 1
      FOR UPDATE`,
    [shopId, normalized]
  );
  if (rows[0]) return rows[0];

  if (itemName) {
    const byName = await client.query(
      `SELECT * FROM inventory WHERE shop_id = $1 AND name = $2 LIMIT 1 FOR UPDATE`,
      [shopId, itemName]
    );
    return byName.rows[0] ?? null;
  }
  return null;
}

async function insertLedger(
  client: PoolClient,
  shopId: string,
  inv: any,
  opts: {
    type: 'SALE' | 'RETURN';
    qtyChange: number;
    grossChange: number;
    netChange: number;
    refNo?: string;
    remarks: string;
  }
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO stock_ledger
        (date, item_id, item_code, item_name, transaction_type,
         qty_change, gross_weight_change, net_weight_change,
         balance_qty, balance_gross_weight, balance_net_weight,
         reference_no, remarks, shop_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        new Date().toISOString().slice(0, 10),
        String(inv.id),
        inv.item_code || inv.barcode || String(inv.id),
        inv.name,
        opts.type,
        opts.qtyChange,
        opts.grossChange,
        opts.netChange,
        inv.stock,
        inv.gross_weight,
        inv.net_weight,
        opts.refNo || '',
        opts.remarks,
        shopId,
      ]
    );
  } catch {
    // ledger write is non-blocking, same as the Mongo route
  }
}

interface ReturnMovementItem {
  productId: string;
  name: string;
  netWeight: number;
  grossWeight?: number;
  stoneWeight?: number;
  qty: number;
}

async function restoreInventoryFromSalesReturn(
  client: PoolClient,
  shopId: string,
  items: ReturnMovementItem[],
  refNo?: string
): Promise<void> {
  for (const item of items) {
    const inv = await resolveInventory(client, shopId, item.productId || '', item.name);
    if (!inv) {
      console.warn(
        `[SalesReturn] Could not find inventory item to restore for productId: ${item.productId}, name: ${item.name}`
      );
      continue;
    }

    const restoreQty = Number(item.qty) || 1;
    const restoreNetWt = Number(item.netWeight) || 0;
    const restoreGrossWt =
      Number(item.grossWeight) ||
      parseGrossWeightFromProductId(item.productId || '') ||
      restoreNetWt;
    const restoreStoneWt = Number(item.stoneWeight) || 0;

    inv.stock = (Number(inv.stock) || 0) + restoreQty;
    inv.net_weight = round3((Number(inv.net_weight) || 0) + restoreNetWt);
    inv.gross_weight = round3((Number(inv.gross_weight) || 0) + restoreGrossWt);
    inv.stone_weight = round3((Number(inv.stone_weight) || 0) + restoreStoneWt);

    await client.query(
      `UPDATE inventory
          SET stock = $1, net_weight = $2, gross_weight = $3, stone_weight = $4,
              updated_at = NOW()
        WHERE id = $5`,
      [inv.stock, inv.net_weight, inv.gross_weight, inv.stone_weight, inv.id]
    );

    await insertLedger(client, shopId, inv, {
      type: 'RETURN',
      qtyChange: restoreQty,
      grossChange: restoreGrossWt,
      netChange: restoreNetWt,
      refNo,
      remarks: 'Sales Return Stock Restoration',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Return-number generation (per shop): SR-0001, SR-0002, ...          */
/* ------------------------------------------------------------------ */

async function getNextSalesReturnNumber(client: PoolClient, shopId: string): Promise<string> {
  const prefix = 'SR-';
  const regex = /^SR-(\d+)$/;
  const { rows } = await client.query(
    `SELECT return_no FROM sales_returns WHERE shop_id = $1`,
    [shopId]
  );

  const used = new Set<number>();
  for (const r of rows) {
    const match = typeof r.return_no === 'string' ? r.return_no.match(regex) : null;
    if (match) used.add(Number(match[1]));
  }

  let nextSeq = 1;
  while (used.has(nextSeq)) nextSeq += 1;
  return prefix + nextSeq.toString().padStart(4, '0');
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

async function serializeReturns(rows: any[]): Promise<any[]> {
  const objs = rows.map((r) => rowToApi<any>(r)!);
  if (objs.length === 0) return objs;

  const ids = objs.map((o) => String(o.id));
  const { rows: itemRows } = await pgPool.query(
    `SELECT * FROM sales_return_items WHERE sales_return_id = ANY($1) ORDER BY id ASC`,
    [ids]
  );
  const grouped = new Map<string, any[]>();
  for (const row of itemRows) {
    const k = String(row.sales_return_id);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(rowToApi(row));
  }
  for (const obj of objs) obj.items = grouped.get(String(obj.id)) ?? [];
  return objs;
}

const movementList = (items: any[]): ReturnMovementItem[] =>
  (Array.isArray(items) ? items : []).map((it) => ({
    productId: it.productId,
    name: it.name,
    netWeight: it.netWeight,
    grossWeight: it.grossWeight ?? it.netWeight,
    stoneWeight: it.stoneWeight ?? 0,
    qty: it.qty || 1,
  }));

/* ------------------------------------------------------------------ */
/* Dues adjustment                                                     */
/* ------------------------------------------------------------------ */

async function applyRefundToDues(
  client: PoolClient,
  shopId: string,
  opts: { invoiceId?: string; customerId?: string; totalRefund: number }
): Promise<void> {
  let remainingRefund = Number(opts.totalRefund) || 0;
  if (remainingRefund <= 0) return;

  if (opts.invoiceId) {
    const invRes = await client.query(
      `SELECT id, balance_due FROM invoices WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
      [shopId, opts.invoiceId]
    );
    if (invRes.rows.length > 0) {
      const currentDue = Number(invRes.rows[0].balance_due) || 0;
      const appliedDeduct = Math.min(currentDue, remainingRefund);
      const newDue = Math.max(0, currentDue - remainingRefund);
      await client.query(
        `UPDATE invoices
            SET balance_due = $1, is_paid = $2, updated_at = NOW()
          WHERE id = $3`,
        [newDue, newDue <= 0, invRes.rows[0].id]
      );
      remainingRefund = Math.max(0, remainingRefund - appliedDeduct);
    }
  }

  if (remainingRefund > 0 && opts.customerId) {
    const openRes = await client.query(
      `SELECT id, balance_due FROM invoices
        WHERE shop_id = $1 AND customer_id = $2 AND balance_due > 0
        ORDER BY created_at ASC
        FOR UPDATE`,
      [shopId, opts.customerId]
    );
    for (const openInv of openRes.rows) {
      if (remainingRefund <= 0) break;
      const cDue = Number(openInv.balance_due) || 0;
      if (cDue <= 0) continue;
      const deduct = Math.min(cDue, remainingRefund);
      const nDue = cDue - deduct;
      await client.query(
        `UPDATE invoices
            SET balance_due = $1, is_paid = $2, updated_at = NOW()
          WHERE id = $3`,
        [nDue, nDue <= 0, openInv.id]
      );
      remainingRefund -= deduct;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.get('/', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM sales_returns WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.pgTenant!.shopId]
    );
    res.json(await serializeReturns(rows));
  } catch (err: any) {
    console.error('[GET /sales-returns] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch sales returns' });
  }
});

router.get('/:id', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM sales_returns WHERE shop_id = $1 AND id = $2`,
      [req.pgTenant!.shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Sales return not found' });
    const [obj] = await serializeReturns(rows);
    res.json(obj);
  } catch (err: any) {
    console.error('[GET /sales-returns/:id] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch sales return' });
  }
});

router.post('/', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = { ...req.body } as any;
      delete body.id;
      delete body._id;
      delete body.returnNo;

      const items: any[] = Array.isArray(body.items) ? body.items : [];

      const created = await withTransaction(async (client) => {
        if (body.invoiceId) {
          const dup = await client.query(
            `SELECT 1 FROM sales_returns WHERE shop_id = $1 AND invoice_id = $2 LIMIT 1`,
            [shopId, body.invoiceId]
          );
          if (dup.rows.length > 0) {
            throw Object.assign(
              new Error(`Invoice ${body.invoiceNumber || ''} has already been returned.`),
              { statusCode: 400 }
            );
          }
        }

        const returnNo = await getNextSalesReturnNumber(client, shopId);

        const extra: Record<string, any> = { shop_id: shopId, return_no: returnNo };
        if (body.date) extra.date = new Date(body.date);
        const { columns, values } = await apiToColumns('sales_returns', body, extra);
        const { rows } = await client.query(
          `INSERT INTO sales_returns (${columns.join(', ')})
           VALUES (${placeholders(values.length)}) RETURNING *`,
          values
        );
        const salesReturn = rows[0];

        for (const it of items) {
          const child = await apiToColumns('sales_return_items', it, {
            sales_return_id: String(salesReturn.id),
          });
          if (child.columns.length === 0) continue;
          await client.query(
            `INSERT INTO sales_return_items (${child.columns.join(', ')})
             VALUES (${placeholders(child.values.length)})`,
            child.values
          );
        }

        if (body.invoiceId) {
          await client.query(
            `UPDATE invoices SET is_returned = true, updated_at = NOW()
              WHERE shop_id = $1 AND id = $2`,
            [shopId, body.invoiceId]
          );
        }

        // 1. Restore inventory stock (qty + gross + net + stone weight)
        await restoreInventoryFromSalesReturn(client, shopId, movementList(items), returnNo);

        // 2. Adjust dues on the linked invoice, then the customer's other open invoices
        await applyRefundToDues(client, shopId, {
          invoiceId: body.invoiceId,
          customerId: body.customerId || salesReturn.customer_id,
          totalRefund: Number(body.totalRefund) || 0,
        });

        return salesReturn;
      });

      const [obj] = await serializeReturns([created]);
      return res.status(201).json(obj);
    } catch (error: any) {
      const isDuplicate =
        error?.code === '23505' || /duplicate key/i.test(error?.message || '');
      if (isDuplicate && attempt < maxAttempts) continue;

      console.error('[POST /sales-returns] failed:', error?.message || error);
      return res
        .status(error?.statusCode || 400)
        .json({ error: error?.message || 'Failed to create sales return' });
    }
  }

  return res
    .status(500)
    .json({ error: 'Failed to generate unique return number after multiple attempts.' });
});

router.delete('/:id', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const result = await withTransaction(async (client) => {
      const retRes = await client.query(
        `SELECT * FROM sales_returns WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [shopId, req.params.id]
      );
      if (retRes.rows.length === 0) return { notFound: true as const };
      const salesReturn = retRes.rows[0];

      if (salesReturn.invoice_id) {
        const invRes = await client.query(
          `SELECT id, balance_due FROM invoices WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, salesReturn.invoice_id]
        );
        if (invRes.rows.length > 0) {
          const refund = Number(salesReturn.total_refund) || 0;
          if (refund > 0) {
            const restoredDue = (Number(invRes.rows[0].balance_due) || 0) + refund;
            await client.query(
              `UPDATE invoices
                  SET is_returned = false, balance_due = $1, is_paid = $2, updated_at = NOW()
                WHERE id = $3`,
              [restoredDue, restoredDue <= 0, invRes.rows[0].id]
            );
          } else {
            await client.query(
              `UPDATE invoices SET is_returned = false, updated_at = NOW() WHERE id = $1`,
              [invRes.rows[0].id]
            );
          }
        }
      }

      await client.query(`DELETE FROM sales_return_items WHERE sales_return_id = $1`, [
        req.params.id,
      ]);
      await client.query(`DELETE FROM sales_returns WHERE shop_id = $1 AND id = $2`, [
        shopId,
        req.params.id,
      ]);
      return { ok: true as const };
    });

    if ('notFound' in result) return res.status(404).json({ error: 'Sales return not found' });
    res.json({ message: 'Sales return record deleted and dues updated.' });
  } catch (error: any) {
    console.error('[DELETE /sales-returns] failed:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to delete sales return' });
  }
});

export default router;
