import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { requirePgTenantAuth } from '../middleware/authPg';
import { apiToColumns, rowToApi, placeholders } from '../db/mapping';

/**
 * PostgreSQL port of `routes/invoices.ts`.
 *
 * `invoice.items` / `invoice.payments` (embedded arrays in Mongo) are the
 * child tables `invoice_items` / `invoice_payments`. Creating / editing /
 * deleting an invoice adjusts `inventory` stock & weights and writes
 * `stock_ledger` rows, all inside one transaction — same logic as before.
 */

const router = Router();
const WRITE_ROLES: Array<'owner' | 'operator'> = ['owner', 'operator'];

/* ------------------------------------------------------------------ */
/* Helpers ported verbatim from routes/invoices.ts                     */
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

function normalizeInvoiceProductId(productId: string): string {
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

function isManualInvoicePayload(body: any): boolean {
  if (!body) return false;
  if (typeof body.number === 'string' && body.number.toUpperCase().startsWith('MAN-')) return true;
  if (
    Array.isArray(body.items) &&
    body.items.some(
      (it: any) =>
        it.productId === 'MANUAL_DUE_ENTRY' ||
        (typeof it.productId === 'string' && it.productId.toLowerCase().startsWith('manual'))
    )
  ) {
    return true;
  }
  return false;
}

const round3 = (n: number) => Number((Number(n) || 0).toFixed(3));

/* ------------------------------------------------------------------ */
/* Invoice number generation                                           */
/* ------------------------------------------------------------------ */

async function getNextInvoiceNumber(
  client: PoolClient,
  shopId: string,
  type: 'GST' | 'NON-GST',
  isManual: boolean
): Promise<string> {
  let prefix = 'INV-';
  let regex = /^INV-(\d+)$/;
  if (isManual) {
    prefix = 'MAN-';
    regex = /^MAN-(\d+)$/;
  } else if (type === 'GST') {
    prefix = 'GST-';
    regex = /^GST-(\d+)$/;
  }

  const { rows } = await client.query(
    `SELECT number, bill_no, type FROM invoices WHERE shop_id = $1`,
    [shopId]
  );

  const used = new Set<number>();
  for (const inv of rows) {
    if (inv.type !== type && !isManual) continue;
    let numVal: number | null = null;
    if (typeof inv.bill_no === 'string' && /^\d+$/.test(inv.bill_no.trim())) {
      numVal = Number(inv.bill_no.trim());
    } else if (typeof inv.number === 'string') {
      const match = inv.number.match(regex);
      if (match) numVal = Number(match[1]);
      else {
        const clean = inv.number.replace(/\D/g, '');
        if (clean) numVal = Number(clean);
      }
    }
    if (numVal && numVal > 0) used.add(numVal);
  }

  let nextSeq = 1;
  while (used.has(nextSeq)) nextSeq += 1;
  return prefix + nextSeq.toString().padStart(4, '0');
}

/* ------------------------------------------------------------------ */
/* Inventory <-> invoice item stock movement                           */
/* ------------------------------------------------------------------ */

async function resolveInventory(
  client: PoolClient,
  shopId: string,
  productId: string
): Promise<any | null> {
  const normalized = normalizeInvoiceProductId(productId);
  const { rows } = await client.query(
    `SELECT * FROM inventory
      WHERE shop_id = $1
        AND (id::text = $2 OR huid = $2 OR barcode = $2 OR item_code = $2)
      LIMIT 1
      FOR UPDATE`,
    [shopId, normalized]
  );
  return rows[0] ?? null;
}

interface MovementItem {
  productId: string;
  netWeight: number;
  qty: number;
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
}

async function applyInventoryDeduction(
  client: PoolClient,
  shopId: string,
  items: MovementItem[],
  refNo?: string
): Promise<void> {
  for (const item of items) {
    const rawProductId = item.productId || '';
    if (isManualOrNonInventoryId(rawProductId)) continue;
    if (isManualOrNonInventoryId(normalizeInvoiceProductId(rawProductId))) continue;

    const inv = await resolveInventory(client, shopId, rawProductId);
    if (!inv) throw new Error(`Inventory item not found for productId: ${item.productId}`);

    const deductStock = Number(item.qty) || 0;
    const deductWt = Number(item.netWeight) || 0;
    const deductGrossWt = parseGrossWeightFromProductId(rawProductId);

    if (Number(inv.stock) < deductStock) throw new Error(`Insufficient stock for ${inv.id}`);
    if (Number(inv.net_weight) < deductWt - 0.001) throw new Error(`Insufficient wt for ${inv.id}`);

    inv.stock = Number(inv.stock) - deductStock;
    inv.net_weight = Math.max(0, round3(Number(inv.net_weight) - deductWt));
    if (deductGrossWt > 0) {
      inv.gross_weight = Math.max(0, round3(Number(inv.gross_weight || 0) - deductGrossWt));
    }

    await client.query(
      `UPDATE inventory SET stock = $1, net_weight = $2, gross_weight = $3, updated_at = NOW() WHERE id = $4`,
      [inv.stock, inv.net_weight, inv.gross_weight, inv.id]
    );

    await insertLedger(client, shopId, inv, {
      type: 'SALE',
      qtyChange: -deductStock,
      grossChange: -deductGrossWt,
      netChange: -deductWt,
      refNo,
      remarks: 'Sales Invoice Stock Deduction',
    });
  }
}

async function restoreInventory(
  client: PoolClient,
  shopId: string,
  items: MovementItem[],
  refNo?: string
): Promise<void> {
  for (const item of items) {
    const rawProductId = item.productId || '';
    if (isManualOrNonInventoryId(rawProductId)) continue;
    if (isManualOrNonInventoryId(normalizeInvoiceProductId(rawProductId))) continue;

    const inv = await resolveInventory(client, shopId, rawProductId);
    if (!inv) continue;

    const restoreStock = Number(item.qty) || 0;
    const restoreWt = Number(item.netWeight) || 0;
    const restoreGrossWt = parseGrossWeightFromProductId(rawProductId);

    inv.stock = Number(inv.stock) + restoreStock;
    inv.net_weight = round3(Number(inv.net_weight) + restoreWt);
    if (restoreGrossWt > 0) {
      inv.gross_weight = round3(Number(inv.gross_weight || 0) + restoreGrossWt);
    }

    await client.query(
      `UPDATE inventory SET stock = $1, net_weight = $2, gross_weight = $3, updated_at = NOW() WHERE id = $4`,
      [inv.stock, inv.net_weight, inv.gross_weight, inv.id]
    );

    await insertLedger(client, shopId, inv, {
      type: 'RETURN',
      qtyChange: restoreStock,
      grossChange: restoreGrossWt,
      netChange: restoreWt,
      refNo,
      remarks: 'Sales Invoice Return / Deletion',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Child-row persistence                                               */
/* ------------------------------------------------------------------ */

async function insertInvoiceChildren(
  client: PoolClient,
  invoiceId: string,
  items: any[],
  payments: any[]
): Promise<void> {
  for (const it of Array.isArray(items) ? items : []) {
    const { columns, values } = await apiToColumns('invoice_items', it, { invoice_id: invoiceId });
    if (columns.length === 0) continue;
    await client.query(
      `INSERT INTO invoice_items (${columns.join(', ')}) VALUES (${placeholders(values.length)})`,
      values
    );
  }
  for (const p of Array.isArray(payments) ? payments : []) {
    const mapped = { paymentDate: p.date ?? p.paymentDate, amount: p.amount, mode: p.mode, note: p.note };
    const { columns, values } = await apiToColumns('invoice_payments', mapped, { invoice_id: invoiceId });
    if (columns.length === 0) continue;
    await client.query(
      `INSERT INTO invoice_payments (${columns.join(', ')}) VALUES (${placeholders(values.length)})`,
      values
    );
  }
}

async function loadInvoiceChildren(invoiceIds: string[]): Promise<{
  items: Map<string, any[]>;
  payments: Map<string, any[]>;
}> {
  const items = new Map<string, any[]>();
  const payments = new Map<string, any[]>();
  if (invoiceIds.length === 0) return { items, payments };

  const itemRes = await pgPool.query(
    `SELECT * FROM invoice_items WHERE invoice_id = ANY($1) ORDER BY id ASC`,
    [invoiceIds]
  );
  for (const row of itemRes.rows) {
    const k = String(row.invoice_id);
    if (!items.has(k)) items.set(k, []);
    items.get(k)!.push(rowToApi(row));
  }

  const payRes = await pgPool.query(
    `SELECT * FROM invoice_payments WHERE invoice_id = ANY($1) ORDER BY payment_date ASC, id ASC`,
    [invoiceIds]
  );
  for (const row of payRes.rows) {
    const k = String(row.invoice_id);
    const mapped = rowToApi<any>(row)!;
    mapped.date = mapped.paymentDate; // frontend expects `date` on a payment
    if (!payments.has(k)) payments.set(k, []);
    payments.get(k)!.push(mapped);
  }
  return { items, payments };
}

async function serializeInvoices(rows: any[]): Promise<any[]> {
  const objs = rows.map((r) => rowToApi<any>(r)!);
  const { items, payments } = await loadInvoiceChildren(objs.map((o) => String(o.id)));
  for (const obj of objs) {
    obj.items = items.get(String(obj.id)) ?? [];
    obj.payments = payments.get(String(obj.id)) ?? [];
  }
  return objs;
}

const movementList = (items: any[]): MovementItem[] =>
  (Array.isArray(items) ? items : []).map((it) => ({
    productId: it.productId,
    netWeight: it.netWeight,
    qty: it.qty,
  }));

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.get('/', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM invoices WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.pgTenant!.shopId]
    );
    res.json(await serializeInvoices(rows));
  } catch (err: any) {
    console.error('[GET /invoices] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM invoices WHERE shop_id = $1 AND id = $2`,
      [req.pgTenant!.shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const [obj] = await serializeInvoices(rows);
    res.json(obj);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.post('/', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = { ...req.body } as any;
      const isManual = isManualInvoicePayload(body);
      const forcedNumber =
        typeof body.number === 'string' && body.number.trim() ? body.number.trim() : null;

      const created = await withTransaction(async (client) => {
        const number =
          forcedNumber || (await getNextInvoiceNumber(client, shopId, body.type, isManual));

        const extra: Record<string, any> = { shop_id: shopId, number };
        if (body.createdAt) extra.created_at = new Date(body.createdAt);

        const { columns, values } = await apiToColumns('invoices', body, extra);
        const { rows } = await client.query(
          `INSERT INTO invoices (${columns.join(', ')}) VALUES (${placeholders(values.length)}) RETURNING *`,
          values
        );
        const invoice = rows[0];

        await insertInvoiceChildren(client, String(invoice.id), body.items, body.payments);
        await applyInventoryDeduction(client, shopId, movementList(body.items), number);
        return invoice;
      });

      const [obj] = await serializeInvoices([created]);
      return res.status(201).json(obj);
    } catch (error: any) {
      const isDuplicate = error?.code === '23505' || /duplicate key/i.test(error?.message || '');
      if (isDuplicate && !((typeof req.body?.number === 'string') && req.body.number.trim()) && attempt < maxAttempts) {
        continue;
      }
      console.error('[POST /invoices] failed:', error?.message || error);
      return res.status(400).json({ error: error?.message || 'Failed to create invoice' });
    }
  }

  return res
    .status(500)
    .json({ error: 'Failed to generate a unique invoice number after multiple attempts.' });
});

router.put('/:id', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const updated = await withTransaction(async (client) => {
      const oldRes = await client.query(
        `SELECT * FROM invoices WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [shopId, req.params.id]
      );
      if (oldRes.rows.length === 0) return { notFound: true as const };
      const oldInvoice = oldRes.rows[0];

      const oldItemsRes = await client.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1`,
        [req.params.id]
      );
      const oldItems = oldItemsRes.rows.map((r) => rowToApi<any>(r)!);

      const body = { ...req.body } as any;
      if (!body.number || typeof body.number !== 'string' || !body.number.trim()) {
        delete body.number;
      } else {
        body.number = body.number.trim();
      }

      // 1. undo the original sale
      await restoreInventory(client, shopId, movementList(oldItems), `${oldInvoice.number} (edit-restore)`);

      // 2. apply the updated sale
      const newItems = movementList(body.items);
      if (newItems.length > 0) {
        await applyInventoryDeduction(client, shopId, newItems, `${oldInvoice.number} (edit)`);
      }

      // 3. persist the invoice row
      const extra: Record<string, any> = {};
      if (body.createdAt) extra.created_at = new Date(body.createdAt);
      const { columns, values } = await apiToColumns('invoices', body, extra);
      let row = oldInvoice;
      if (columns.length > 0) {
        const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
        const upd = await client.query(
          `UPDATE invoices SET ${setClause}, updated_at = NOW()
            WHERE shop_id = $${columns.length + 1} AND id = $${columns.length + 2} RETURNING *`,
          [...values, shopId, req.params.id]
        );
        row = upd.rows[0];
      }

      // 4. replace child rows when the payload carries them
      if (Object.prototype.hasOwnProperty.call(req.body, 'items') ||
          Object.prototype.hasOwnProperty.call(req.body, 'payments')) {
        await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [req.params.id]);
        await client.query(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [req.params.id]);
        await insertInvoiceChildren(
          client,
          req.params.id,
          req.body.items ?? [],
          req.body.payments ?? []
        );
      }
      return { row };
    });

    if ('notFound' in updated) return res.status(404).json({ error: 'Invoice not found' });
    const [obj] = await serializeInvoices([updated.row]);
    res.json(obj);
  } catch (error: any) {
    console.error('[PUT /invoices] failed:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to update invoice' });
  }
});

router.delete('/:id', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const result = await withTransaction(async (client) => {
      const invRes = await client.query(
        `SELECT * FROM invoices WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [shopId, req.params.id]
      );
      if (invRes.rows.length === 0) return { notFound: true as const };
      const invoice = invRes.rows[0];

      const itemsRes = await client.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1`,
        [req.params.id]
      );
      const items = itemsRes.rows.map((r) => rowToApi<any>(r)!);

      const linked = await client.query(
        `SELECT COUNT(*)::int AS n FROM sales_returns WHERE shop_id = $1 AND invoice_id = $2`,
        [shopId, req.params.id]
      );
      const linkedReturns = linked.rows[0].n as number;

      if (linkedReturns === 0) {
        await restoreInventory(client, shopId, movementList(items), invoice.number);
      }

      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM invoices WHERE shop_id = $1 AND id = $2`, [shopId, req.params.id]);
      await client.query(`DELETE FROM sales_returns WHERE shop_id = $1 AND invoice_id = $2`, [
        shopId,
        req.params.id,
      ]);

      return { linkedReturns };
    });

    if ('notFound' in result) return res.status(404).json({ error: 'Invoice not found' });
    res.json({
      message:
        result.linkedReturns > 0
          ? 'Invoice deleted. Inventory unchanged (already restored by sales return).'
          : 'Invoice deleted and inventory restored.',
    });
  } catch (error: any) {
    console.error('[DELETE /invoices] failed:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to delete invoice' });
  }
});

export default router;
