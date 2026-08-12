import { Router, Request, Response } from 'express';
import { requireTenantAuth } from '../middleware/auth';

const router = Router();
router.use(requireTenantAuth());

// Helper for generic master CRUD
function createMasterCrudRoutes(
  router: Router,
  path: string,
  getModel: (req: Request) => any,
  name: string
) {
  // GET ALL
  router.get(path, async (req: Request, res: Response) => {
    try {
      const model = getModel(req);
      const items = await model.find().sort({ createdAt: -1 });
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: `Failed to fetch ${name} list: ${err.message}` });
    }
  });

  // GET ONE
  router.get(`${path}/:id`, async (req: Request, res: Response) => {
    try {
      const model = getModel(req);
      const item = await model.findById(req.params.id);
      if (!item) return res.status(404).json({ error: `${name} not found` });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ error: `Failed to fetch ${name}: ${err.message}` });
    }
  });

  // CREATE
  router.post(path, async (req: Request, res: Response) => {
    try {
      const model = getModel(req);
      const doc = new model(req.body);
      await doc.save();
      res.status(201).json(doc);
    } catch (err: any) {
      res.status(400).json({ error: `Failed to create ${name}: ${err.message}` });
    }
  });

  // UPDATE
  router.put(`${path}/:id`, async (req: Request, res: Response) => {
    try {
      const model = getModel(req);
      const doc = await model.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!doc) return res.status(404).json({ error: `${name} not found` });
      res.json(doc);
    } catch (err: any) {
      res.status(400).json({ error: `Failed to update ${name}: ${err.message}` });
    }
  });

  // DELETE
  router.delete(`${path}/:id`, async (req: Request, res: Response) => {
    try {
      const model = getModel(req);
      const doc = await model.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ error: `${name} not found` });
      res.json({ message: `${name} deleted successfully` });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to delete ${name}: ${err.message}` });
    }
  });
}

// ----------------------------------------------------
// 1-10: Masters Routes
// ----------------------------------------------------
createMasterCrudRoutes(router, '/categories', (req) => req.tenant!.models.Category, 'Category');
createMasterCrudRoutes(router, '/subcategories', (req) => req.tenant!.models.SubCategory, 'SubCategory');
createMasterCrudRoutes(router, '/brands', (req) => req.tenant!.models.Brand, 'Brand');
createMasterCrudRoutes(router, '/collections', (req) => req.tenant!.models.CollectionMaster, 'Collection');
createMasterCrudRoutes(router, '/purities', (req) => req.tenant!.models.PurityMaster, 'Purity');
createMasterCrudRoutes(router, '/metals', (req) => req.tenant!.models.MetalMaster, 'Metal');
createMasterCrudRoutes(router, '/stones', (req) => req.tenant!.models.StoneMaster, 'Stone');
createMasterCrudRoutes(router, '/diamonds', (req) => req.tenant!.models.DiamondMaster, 'Diamond');
createMasterCrudRoutes(router, '/units', (req) => req.tenant!.models.UnitMaster, 'Unit');
createMasterCrudRoutes(router, '/hsn', (req) => req.tenant!.models.HsnMaster, 'HSN Code');

// ----------------------------------------------------
// 11. STOCK ADJUSTMENT
// ----------------------------------------------------
router.get('/adjustments', async (req: Request, res: Response) => {
  try {
    const list = await req.tenant!.models.StockAdjustment.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/adjustments', async (req: Request, res: Response) => {
  try {
    const { itemId, type, qty, grossWeight, netWeight, reason, remarks } = req.body;
    const inventoryModel = req.tenant!.models.Inventory;
    const adjustmentModel = req.tenant!.models.StockAdjustment;
    const ledgerModel = req.tenant!.models.StockLedger;

    const item = await inventoryModel.findById(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const changeFactor = type === 'INCREASE' ? 1 : -1;
    const qtyChange = (Number(qty) || 1) * changeFactor;
    const gwChange = (Number(grossWeight) || 0) * changeFactor;
    const nwChange = (Number(netWeight) || 0) * changeFactor;

    item.stock = Math.max(0, (item.stock || 0) + qtyChange);
    item.grossWeight = Math.max(0, (item.grossWeight || 0) + gwChange);
    item.netWeight = Math.max(0, (item.netWeight || 0) + nwChange);
    await item.save();

    const adjustmentNo = `ADJ-${Date.now().toString().slice(-6)}`;
    const adj = new adjustmentModel({
      adjustmentNo,
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      type,
      qty: Math.abs(qtyChange),
      grossWeight: Math.abs(gwChange),
      netWeight: Math.abs(nwChange),
      reason,
      remarks,
      createdBy: (req as any).tenantUser?.name || 'Admin',
    });
    await adj.save();

    // Record Stock Ledger Entry
    const ledgerEntry = new ledgerModel({
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      transactionType: 'ADJUSTMENT',
      qtyChange,
      grossWeightChange: gwChange,
      netWeightChange: nwChange,
      balanceQty: item.stock,
      balanceGrossWeight: item.grossWeight,
      balanceNetWeight: item.netWeight,
      referenceNo: adjustmentNo,
      remarks: `Reason: ${reason} ${remarks ? '(' + remarks + ')' : ''}`,
    });
    await ledgerEntry.save();

    res.status(201).json({ adjustment: adj, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 12. STOCK TRANSFER
// ----------------------------------------------------
router.get('/transfers', async (req: Request, res: Response) => {
  try {
    const list = await req.tenant!.models.StockTransfer.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/transfers', async (req: Request, res: Response) => {
  try {
    const { itemId, fromBranch, toBranch, fromGodown, toGodown, qty, grossWeight, netWeight, remarks } = req.body;
    const inventoryModel = req.tenant!.models.Inventory;
    const transferModel = req.tenant!.models.StockTransfer;
    const ledgerModel = req.tenant!.models.StockLedger;

    const item = await inventoryModel.findById(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Update item location info
    item.branch = toBranch || item.branch;
    if (toGodown) item.godown = toGodown;
    await item.save();

    const transferNo = `TRF-${Date.now().toString().slice(-6)}`;
    const transfer = new transferModel({
      transferNo,
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      fromBranch: fromBranch || 'Main Store',
      toBranch: toBranch || 'Secondary Branch',
      fromGodown,
      toGodown,
      qty: Number(qty) || 1,
      grossWeight: Number(grossWeight) || item.grossWeight,
      netWeight: Number(netWeight) || item.netWeight,
      status: 'Completed',
      remarks,
      createdBy: (req as any).tenantUser?.name || 'Admin',
    });
    await transfer.save();

    // Record Stock Ledger Entry
    const ledgerEntry = new ledgerModel({
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      transactionType: 'TRANSFER',
      qtyChange: 0,
      grossWeightChange: 0,
      netWeightChange: 0,
      balanceQty: item.stock,
      balanceGrossWeight: item.grossWeight,
      balanceNetWeight: item.netWeight,
      referenceNo: transferNo,
      remarks: `Moved from ${fromBranch || 'Main'} to ${toBranch || 'Secondary'}${toGodown ? ' (' + toGodown + ')' : ''}`,
    });
    await ledgerEntry.save();

    res.status(201).json({ transfer, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 13. STOCK LEDGER
// ----------------------------------------------------
router.get('/ledger', async (req: Request, res: Response) => {
  try {
    const { itemId } = req.query;
    const filter: any = {};
    if (itemId) filter.itemId = itemId;
    const ledger = await req.tenant!.models.StockLedger.find(filter).sort({ createdAt: -1 });

    const activeItems = await req.tenant!.models.Inventory.find().select('_id name itemCode');
    const validItemIds = new Set(activeItems.map((i: any) => i._id.toString()));
    const validItemNames = new Set(activeItems.map((i: any) => (i.name || '').trim().toLowerCase()));

    const filtered = ledger.filter((entry: any) => {
      if (entry.itemId && validItemIds.has(entry.itemId.toString())) return true;
      if (entry.itemName && validItemNames.has((entry.itemName || '').trim().toLowerCase())) return true;
      if (entry.item && validItemNames.has((entry.item || '').trim().toLowerCase())) return true;
      return false;
    });

    res.json(filtered);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ----------------------------------------------------
// 14. OPENING STOCK ENTRY
// ----------------------------------------------------
router.get('/opening-stock', async (req: Request, res: Response) => {
  try {
    const list = await req.tenant!.models.OpeningStock.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/opening-stock', async (req: Request, res: Response) => {
  try {
    const { itemId, qty, grossWeight, netWeight, rate, totalValue, remarks } = req.body;
    const inventoryModel = req.tenant!.models.Inventory;
    const openingModel = req.tenant!.models.OpeningStock;
    const ledgerModel = req.tenant!.models.StockLedger;

    const item = await inventoryModel.findById(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.stock = Number(qty) || 1;
    if (grossWeight) item.grossWeight = Number(grossWeight);
    if (netWeight) item.netWeight = Number(netWeight);
    if (rate) item.costPrice = Number(rate);
    await item.save();

    const entryNo = `OPN-${Date.now().toString().slice(-6)}`;
    const opn = new openingModel({
      entryNo,
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      qty: Number(qty) || 1,
      grossWeight: Number(grossWeight) || item.grossWeight,
      netWeight: Number(netWeight) || item.netWeight,
      rate: Number(rate) || 0,
      totalValue: Number(totalValue) || (item.costPrice ? item.costPrice * item.stock : 0),
      remarks,
      createdBy: (req as any).tenantUser?.name || 'Admin',
    });
    await opn.save();

    // Record Stock Ledger
    const ledgerEntry = new ledgerModel({
      date: new Date().toISOString().slice(0, 10),
      itemId: item._id,
      itemCode: item.itemCode || item.barcode || item._id.toString(),
      itemName: item.name,
      transactionType: 'OPENING',
      qtyChange: Number(qty) || 1,
      grossWeightChange: Number(grossWeight) || item.grossWeight,
      netWeightChange: Number(netWeight) || item.netWeight,
      balanceQty: item.stock,
      balanceGrossWeight: item.grossWeight,
      balanceNetWeight: item.netWeight,
      referenceNo: entryNo,
      remarks: `Opening Stock Initialized`,
    });
    await ledgerEntry.save();

    res.status(201).json({ openingStock: opn, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 15. INVENTORY ANALYTICS & SUMMARY REPORT
// ----------------------------------------------------
router.get('/reports/summary', async (req: Request, res: Response) => {
  try {
    const items = await req.tenant!.models.Inventory.find();
    let totalItemsCount = items.length;
    let totalStockQty = 0;
    let totalGrossWeight = 0;
    let totalNetWeight = 0;
    let totalValuationCost = 0;
    let lowStockCount = 0;

    const categoryBreakdown: Record<string, { count: number; qty: number; netWeight: number; valuation: number }> = {};
    const purityBreakdown: Record<string, { count: number; netWeight: number }> = {};

    items.forEach((item) => {
      const q = item.stock || 0;
      const gw = item.grossWeight || 0;
      const nw = item.netWeight || 0;
      const cost = (item.costPrice || item.sellingPrice || 0) * q;

      totalStockQty += q;
      totalGrossWeight += gw;
      totalNetWeight += nw;
      totalValuationCost += cost;

      if (q <= (item.reorderLevel || item.minStock || 1)) {
        lowStockCount++;
      }

      // Category breakdown
      const cat = item.category || 'Uncategorized';
      if (!categoryBreakdown[cat]) {
        categoryBreakdown[cat] = { count: 0, qty: 0, netWeight: 0, valuation: 0 };
      }
      categoryBreakdown[cat].count += 1;
      categoryBreakdown[cat].qty += q;
      categoryBreakdown[cat].netWeight += nw;
      categoryBreakdown[cat].valuation += cost;

      // Purity breakdown
      const pur = item.purity || 'Unknown';
      if (!purityBreakdown[pur]) {
        purityBreakdown[pur] = { count: 0, netWeight: 0 };
      }
      purityBreakdown[pur].count += 1;
      purityBreakdown[pur].netWeight += nw;

    });

    res.json({
      totalItemsCount,
      totalStockQty,
      totalGrossWeight,
      totalNetWeight,
      totalValuationCost,
      lowStockCount,
      categoryBreakdown,
      purityBreakdown,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
