import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { requirePgTenantAuth } from '../middleware/authPg';
import { buildPgCrudRouter } from '../db/crud';
import { rowToApi } from '../db/mapping';

/**
 * PostgreSQL port of `routes/inventory-extended.ts` (mounted at
 * `/api/inventory-extended`).
 *
 *  - The 10 "master" lists (categories, subcategories, brands, collections,
 *    purities, metals, stones, diamonds, units, hsn) were generic Mongoose
 *    CRUD; here each is a `buildPgCrudRouter` over its own table.
 *  - Stock adjustment / transfer / opening-stock each mutate `inventory` and
 *    append a `stock_ledger` row, inside one transaction (same as before).
 *  - `/ledger` returns ledger rows whose item still exists in `inventory`.
 *  - `/reports/summary` aggregates the shop's `inventory`.
 */

const router = Router();

/* ------------------------------------------------------------------ */
/* 1-10: master lists                                                  */
/* ------------------------------------------------------------------ */

router.use('/categories', buildPgCrudRouter('categories', { resourceName: 'Category', idType: 'text', idPrefix: 'cat' }));
router.use('/subcategories', buildPgCrudRouter('subcategories', { resourceName: 'SubCategory', idType: 'text', idPrefix: 'subcat' }));
router.use('/brands', buildPgCrudRouter('brands', { resourceName: 'Brand', idType: 'text', idPrefix: 'brand' }));
router.use('/collections', buildPgCrudRouter('collection_masters', { resourceName: 'Collection', idType: 'text', idPrefix: 'coll' }));
router.use('/purities', buildPgCrudRouter('purity_masters', { resourceName: 'Purity', idType: 'text', idPrefix: 'purity' }));
router.use('/metals', buildPgCrudRouter('metal_masters', { resourceName: 'Metal', idType: 'text', idPrefix: 'metal' }));
router.use('/stones', buildPgCrudRouter('stone_masters', { resourceName: 'Stone', idType: 'text', idPrefix: 'stone' }));
router.use('/diamonds', buildPgCrudRouter('diamond_masters', { resourceName: 'Diamond', idType: 'text', idPrefix: 'diamond' }));
router.use('/units', buildPgCrudRouter('unit_masters', { resourceName: 'Unit', idType: 'text', idPrefix: 'unit' }));
router.use('/hsn', buildPgCrudRouter('hsn_masters', { resourceName: 'HSN Code', idType: 'text', idPrefix: 'hsn' }));

/* ------------------------------------------------------------------ */
/* Shared helpers for the stock-movement endpoints                     */
/* ------------------------------------------------------------------ */

const WRITE_ROLES: Array<'owner' | 'operator'> = ['owner', 'operator'];
const round3 = (n: number) => Number((Number(n) || 0).toFixed(3));

async function findInventoryById(
  client: PoolClient,
  shopId: string,
  itemId: string
): Promise<any | null> {
  const { rows } = await client.query(
    `SELECT * FROM inventory
      WHERE shop_id = $1 AND (id::text = $2 OR barcode = $2 OR item_code = $2 OR huid = $2)
      LIMIT 1
      FOR UPDATE`,
    [shopId, String(itemId ?? '')]
  );
  return rows[0] ?? null;
}

async function appendLedger(
  client: PoolClient,
  shopId: string,
  item: any,
  opts: {
    transactionType: 'OPENING' | 'TRANSFER' | 'ADJUSTMENT';
    qtyChange: number;
    grossWeightChange: number;
    netWeightChange: number;
    referenceNo: string;
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
      String(item.id),
      item.item_code || item.barcode || String(item.id),
      item.name,
      opts.transactionType,
      opts.qtyChange,
      opts.grossWeightChange,
      opts.netWeightChange,
      item.stock,
      item.gross_weight,
      item.net_weight,
      opts.referenceNo,
      opts.remarks,
      shopId,
    ]
  );
}

/* ------------------------------------------------------------------ */
/* 11. Stock adjustment                                                */
/* ------------------------------------------------------------------ */

router.get('/adjustments', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM stock_adjustments WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.pgTenant!.shopId]
    );
    res.json(rows.map((r) => rowToApi(r)));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch adjustments' });
  }
});

router.post('/adjustments', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const { itemId, type, qty, grossWeight, netWeight, reason, remarks } = req.body;

    const out = await withTransaction(async (client) => {
      const item = await findInventoryById(client, shopId, itemId);
      if (!item) return { notFound: true as const };

      const changeFactor = type === 'INCREASE' ? 1 : -1;
      const qtyChange = (Number(qty) || 1) * changeFactor;
      const gwChange = (Number(grossWeight) || 0) * changeFactor;
      const nwChange = (Number(netWeight) || 0) * changeFactor;

      item.stock = Math.max(0, (Number(item.stock) || 0) + qtyChange);
      item.gross_weight = Math.max(0, round3((Number(item.gross_weight) || 0) + gwChange));
      item.net_weight = Math.max(0, round3((Number(item.net_weight) || 0) + nwChange));

      await client.query(
        `UPDATE inventory SET stock = $1, gross_weight = $2, net_weight = $3, updated_at = NOW()
          WHERE id = $4`,
        [item.stock, item.gross_weight, item.net_weight, item.id]
      );

      const adjustmentNo = `ADJ-${Date.now().toString().slice(-6)}`;
      const { rows } = await client.query(
        `INSERT INTO stock_adjustments
          (adjustment_no, date, item_id, item_code, item_name, type,
           qty, gross_weight, net_weight, reason, remarks, created_by, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          adjustmentNo,
          new Date().toISOString().slice(0, 10),
          String(item.id),
          item.item_code || item.barcode || String(item.id),
          item.name,
          type,
          Math.abs(qtyChange),
          Math.abs(gwChange),
          Math.abs(nwChange),
          reason ?? '',
          remarks ?? null,
          req.tenantAuth!.username || 'Admin',
          shopId,
        ]
      );

      await appendLedger(client, shopId, item, {
        transactionType: 'ADJUSTMENT',
        qtyChange,
        grossWeightChange: gwChange,
        netWeightChange: nwChange,
        referenceNo: adjustmentNo,
        remarks: `Reason: ${reason ?? ''} ${remarks ? '(' + remarks + ')' : ''}`.trim(),
      });

      return { adjustment: rows[0], item };
    });

    if ('notFound' in out) return res.status(404).json({ error: 'Item not found' });
    res.status(201).json({ adjustment: rowToApi(out.adjustment), item: rowToApi(out.item) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to record adjustment' });
  }
});

/* ------------------------------------------------------------------ */
/* 12. Stock transfer                                                  */
/* ------------------------------------------------------------------ */

router.get('/transfers', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM stock_transfers WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.pgTenant!.shopId]
    );
    res.json(rows.map((r) => rowToApi(r)));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch transfers' });
  }
});

router.post('/transfers', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const {
      itemId, fromBranch, toBranch, fromGodown, toGodown,
      qty, grossWeight, netWeight, remarks,
    } = req.body;

    const out = await withTransaction(async (client) => {
      const item = await findInventoryById(client, shopId, itemId);
      if (!item) return { notFound: true as const };

      item.branch = toBranch || item.branch;
      if (toGodown) item.godown = toGodown;
      await client.query(
        `UPDATE inventory SET branch = $1, godown = $2, updated_at = NOW() WHERE id = $3`,
        [item.branch, item.godown, item.id]
      );

      const transferNo = `TRF-${Date.now().toString().slice(-6)}`;
      const { rows } = await client.query(
        `INSERT INTO stock_transfers
          (transfer_no, date, item_id, item_code, item_name,
           from_branch, to_branch, from_godown, to_godown,
           qty, gross_weight, net_weight, status, remarks, created_by, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          transferNo,
          new Date().toISOString().slice(0, 10),
          String(item.id),
          item.item_code || item.barcode || String(item.id),
          item.name,
          fromBranch || 'Main Store',
          toBranch || 'Secondary Branch',
          fromGodown ?? null,
          toGodown ?? null,
          Number(qty) || 1,
          Number(grossWeight) || Number(item.gross_weight) || 0,
          Number(netWeight) || Number(item.net_weight) || 0,
          'Completed',
          remarks ?? null,
          req.tenantAuth!.username || 'Admin',
          shopId,
        ]
      );

      await appendLedger(client, shopId, item, {
        transactionType: 'TRANSFER',
        qtyChange: 0,
        grossWeightChange: 0,
        netWeightChange: 0,
        referenceNo: transferNo,
        remarks: `Moved from ${fromBranch || 'Main'} to ${toBranch || 'Secondary'}${
          toGodown ? ' (' + toGodown + ')' : ''
        }`,
      });

      return { transfer: rows[0], item };
    });

    if ('notFound' in out) return res.status(404).json({ error: 'Item not found' });
    res.status(201).json({ transfer: rowToApi(out.transfer), item: rowToApi(out.item) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to record transfer' });
  }
});

/* ------------------------------------------------------------------ */
/* 13. Stock ledger                                                    */
/* ------------------------------------------------------------------ */

router.get('/ledger', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { itemId } = req.query;

    const params: any[] = [shopId];
    let where = `shop_id = $1`;
    if (itemId) {
      params.push(String(itemId));
      where += ` AND item_id = $2`;
    }
    const { rows: ledger } = await pgPool.query(
      `SELECT * FROM stock_ledger WHERE ${where} ORDER BY created_at DESC`,
      params
    );

    const { rows: activeItems } = await pgPool.query(
      `SELECT id, name FROM inventory WHERE shop_id = $1`,
      [shopId]
    );
    const validItemIds = new Set(activeItems.map((i: any) => String(i.id)));
    const validItemNames = new Set(
      activeItems.map((i: any) => (i.name || '').trim().toLowerCase())
    );

    const filtered = ledger.filter((entry: any) => {
      if (entry.item_id && validItemIds.has(String(entry.item_id))) return true;
      if (entry.item_name && validItemNames.has((entry.item_name || '').trim().toLowerCase())) return true;
      return false;
    });

    res.json(filtered.map((r) => rowToApi(r)));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch ledger' });
  }
});

/* ------------------------------------------------------------------ */
/* 14. Opening stock entry                                             */
/* ------------------------------------------------------------------ */

router.get('/opening-stock', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM opening_stock WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.pgTenant!.shopId]
    );
    res.json(rows.map((r) => rowToApi(r)));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch opening stock' });
  }
});

router.post('/opening-stock', requirePgTenantAuth(WRITE_ROLES), async (req: Request, res: Response) => {
  const shopId = req.pgTenant!.shopId;
  try {
    const { itemId, qty, grossWeight, netWeight, rate, totalValue, remarks } = req.body;

    const out = await withTransaction(async (client) => {
      const item = await findInventoryById(client, shopId, itemId);
      if (!item) return { notFound: true as const };

      item.stock = Number(qty) || 1;
      if (grossWeight) item.gross_weight = Number(grossWeight);
      if (netWeight) item.net_weight = Number(netWeight);
      if (rate) item.cost_price = Number(rate);
      await client.query(
        `UPDATE inventory SET stock = $1, gross_weight = $2, net_weight = $3, cost_price = $4,
              updated_at = NOW()
          WHERE id = $5`,
        [item.stock, item.gross_weight, item.net_weight, item.cost_price, item.id]
      );

      const entryNo = `OPN-${Date.now().toString().slice(-6)}`;
      const { rows } = await client.query(
        `INSERT INTO opening_stock
          (entry_no, date, item_id, item_code, item_name,
           qty, gross_weight, net_weight, rate, total_value, remarks, created_by, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          entryNo,
          new Date().toISOString().slice(0, 10),
          String(item.id),
          item.item_code || item.barcode || String(item.id),
          item.name,
          Number(qty) || 1,
          Number(grossWeight) || Number(item.gross_weight) || 0,
          Number(netWeight) || Number(item.net_weight) || 0,
          Number(rate) || 0,
          Number(totalValue) || (item.cost_price ? Number(item.cost_price) * Number(item.stock) : 0),
          remarks ?? null,
          req.tenantAuth!.username || 'Admin',
          shopId,
        ]
      );

      await appendLedger(client, shopId, item, {
        transactionType: 'OPENING',
        qtyChange: Number(qty) || 1,
        grossWeightChange: Number(grossWeight) || Number(item.gross_weight) || 0,
        netWeightChange: Number(netWeight) || Number(item.net_weight) || 0,
        referenceNo: entryNo,
        remarks: 'Opening Stock Initialized',
      });

      return { openingStock: rows[0], item };
    });

    if ('notFound' in out) return res.status(404).json({ error: 'Item not found' });
    res.status(201).json({ openingStock: rowToApi(out.openingStock), item: rowToApi(out.item) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to record opening stock' });
  }
});

/* ------------------------------------------------------------------ */
/* 15. Inventory analytics & summary                                   */
/* ------------------------------------------------------------------ */

router.get('/reports/summary', requirePgTenantAuth(), async (req: Request, res: Response) => {
  try {
    const { rows: items } = await pgPool.query(
      `SELECT category, purity, stock, gross_weight, net_weight,
              cost_price, selling_price, reorder_level, min_stock
         FROM inventory
        WHERE shop_id = $1`,
      [req.pgTenant!.shopId]
    );

    let totalStockQty = 0;
    let totalGrossWeight = 0;
    let totalNetWeight = 0;
    let totalValuationCost = 0;
    let lowStockCount = 0;

    const categoryBreakdown: Record<
      string,
      { count: number; qty: number; netWeight: number; valuation: number }
    > = {};
    const purityBreakdown: Record<string, { count: number; netWeight: number }> = {};

    for (const item of items) {
      const q = Number(item.stock) || 0;
      const gw = Number(item.gross_weight) || 0;
      const nw = Number(item.net_weight) || 0;
      const cost = (Number(item.cost_price) || Number(item.selling_price) || 0) * q;

      totalStockQty += q;
      totalGrossWeight += gw;
      totalNetWeight += nw;
      totalValuationCost += cost;

      if (q <= (Number(item.reorder_level) || Number(item.min_stock) || 1)) {
        lowStockCount++;
      }

      const cat = item.category || 'Uncategorized';
      if (!categoryBreakdown[cat]) {
        categoryBreakdown[cat] = { count: 0, qty: 0, netWeight: 0, valuation: 0 };
      }
      categoryBreakdown[cat].count += 1;
      categoryBreakdown[cat].qty += q;
      categoryBreakdown[cat].netWeight += nw;
      categoryBreakdown[cat].valuation += cost;

      const pur = item.purity || 'Unknown';
      if (!purityBreakdown[pur]) purityBreakdown[pur] = { count: 0, netWeight: 0 };
      purityBreakdown[pur].count += 1;
      purityBreakdown[pur].netWeight += nw;
    }

    res.json({
      totalItemsCount: items.length,
      totalStockQty,
      totalGrossWeight,
      totalNetWeight,
      totalValuationCost,
      lowStockCount,
      categoryBreakdown,
      purityBreakdown,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to build summary' });
  }
});

export default router;
