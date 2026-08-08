import { Router, Request, Response } from 'express';
import { Model } from 'mongoose';
import { requireTenantAuth } from '../middleware/auth';
import { IInventory } from '../models/tenant/Inventory';
import { ISalesReturn } from '../models/tenant/SalesReturn';

const router = Router();

function normalizeProductId(productId: string) {
  if (!productId || typeof productId !== 'string') return productId;
  if (productId.startsWith('manual-')) return productId;
  if (productId.includes('__GW_')) {
    return productId.split('__GW_')[0];
  }
  return productId;
}

async function getNextSalesReturnNumber(SalesReturnModel: Model<ISalesReturn>, session: any) {
  const prefix = 'SR-';
  const regex = /^SR-(\d+)$/;
  const returns = await SalesReturnModel.find().select('returnNo').session(session).lean();

  const used = new Set<number>();
  for (const ret of returns) {
    const match = typeof ret.returnNo === 'string' ? ret.returnNo.match(regex) : null;
    if (match) {
      used.add(Number(match[1]));
    }
  }

  let nextSeq = 1;
  while (used.has(nextSeq)) {
    nextSeq += 1;
  }

  return prefix + nextSeq.toString().padStart(4, '0');
}

async function restoreInventoryFromSalesReturn(
  InventoryModel: Model<IInventory>,
  returnItems: Array<{ productId: string; netWeight: number; qty: number; name: string }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of returnItems) {
    const normalizedProductId = normalizeProductId(item.productId || '');
    if (!normalizedProductId || normalizedProductId.startsWith('manual')) {
      continue;
    }

    let inventory: any = null;
    try {
      inventory = await InventoryModel.findById(normalizedProductId).session(session);
    } catch {
      // ignore cast error
    }
    if (!inventory) {
      inventory = await InventoryModel.findOne({ huid: normalizedProductId }).session(session);
    }
    if (!inventory) {
      try {
        inventory = await InventoryModel.findOne({ _id: normalizedProductId }).session(session);
      } catch {
        // ignore
      }
    }

    if (inventory) {
      const restoreQty = item.qty || 1;
      const restoreWt = item.netWeight || 0;

      inventory.stock = (inventory.stock || 0) + restoreQty;
      inventory.netWeight = Number(((inventory.netWeight || 0) + restoreWt).toFixed(3));
      await inventory.save({ session });

      if (StockLedgerModel) {
        try {
          const ledgerEntry = new StockLedgerModel({
            date: new Date().toISOString().slice(0, 10),
            itemId: inventory._id,
            itemCode: inventory.itemCode || inventory.barcode || inventory._id.toString(),
            itemName: inventory.name,
            transactionType: 'RETURN',
            qtyChange: restoreQty,
            grossWeightChange: restoreWt,
            netWeightChange: restoreWt,
            balanceQty: inventory.stock,
            balanceGrossWeight: inventory.grossWeight,
            balanceNetWeight: inventory.netWeight,
            referenceNo: refNo || '',
            remarks: 'Sales Return Stock Restoration',
          });
          await ledgerEntry.save({ session });
        } catch {
          // non-blocking
        }
      }
    }
  }
}

async function deductInventoryFromSalesReturnReversal(
  InventoryModel: Model<IInventory>,
  returnItems: Array<{ productId: string; netWeight: number; qty: number; name: string }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of returnItems) {
    const normalizedProductId = normalizeProductId(item.productId || '');
    if (!normalizedProductId || normalizedProductId.startsWith('manual')) {
      continue;
    }

    let inventory: any = null;
    try {
      inventory = await InventoryModel.findById(normalizedProductId).session(session);
    } catch {
      // ignore
    }
    if (!inventory) {
      inventory = await InventoryModel.findOne({ huid: normalizedProductId }).session(session);
    }
    if (!inventory) {
      try {
        inventory = await InventoryModel.findOne({ _id: normalizedProductId }).session(session);
      } catch {
        // ignore
      }
    }

    if (inventory) {
      const deductQty = item.qty || 1;
      const deductWt = item.netWeight || 0;

      inventory.stock = Math.max(0, (inventory.stock || 0) - deductQty);
      inventory.netWeight = Math.max(0, Number(((inventory.netWeight || 0) - deductWt).toFixed(3)));
      await inventory.save({ session });

      if (StockLedgerModel) {
        try {
          const ledgerEntry = new StockLedgerModel({
            date: new Date().toISOString().slice(0, 10),
            itemId: inventory._id,
            itemCode: inventory.itemCode || inventory.barcode || inventory._id.toString(),
            itemName: inventory.name,
            transactionType: 'SALE',
            qtyChange: -deductQty,
            grossWeightChange: -deductWt,
            netWeightChange: -deductWt,
            balanceQty: inventory.stock,
            balanceGrossWeight: inventory.grossWeight,
            balanceNetWeight: inventory.netWeight,
            referenceNo: refNo || '',
            remarks: 'Sales Return Deletion Stock Deduction',
          });
          await ledgerEntry.save({ session });
        } catch {
          // non-blocking
        }
      }
    }
  }
}

router.get('/', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const returns = await req.tenant!.models.SalesReturn.find().sort({ createdAt: -1 });
    res.json(returns.map((r) => r.toJSON()));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sales returns' });
  }
});

router.get('/:id', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const salesReturn = await req.tenant!.models.SalesReturn.findById(req.params.id);
    if (!salesReturn) return res.status(404).json({ error: 'Sales return not found' });
    res.json(salesReturn.toJSON());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sales return' });
  }
});

router.post('/', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  const { SalesReturn, Inventory, StockLedger, Invoice } = req.tenant!.models;

  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const session = await Inventory.startSession();
    try {
      session.startTransaction();
      const body = { ...req.body } as any;
      delete body.id;
      delete body._id;
      delete body.returnNo;

      if (body.date) {
        body.date = new Date(body.date);
      }

      const returnNo = await getNextSalesReturnNumber(SalesReturn, session);
      const salesReturn = new SalesReturn({ ...body, returnNo });
      const savedReturn = await salesReturn.save({ session });

      // 1. Restore Inventory Stock
      await restoreInventoryFromSalesReturn(
        Inventory,
        savedReturn.items.map((it: any) => ({
          productId: it.productId,
          netWeight: it.netWeight,
          qty: it.qty || 1,
          name: it.name,
        })),
        session,
        StockLedger,
        returnNo
      );

      // 2. Adjust Dues on Invoice if requested
      if (body.invoiceId && body.refundMode === 'Adjust Dues' && body.totalRefund > 0) {
        const inv = await Invoice.findById(body.invoiceId).session(session);
        if (inv) {
          const currentDue = inv.balanceDue || 0;
          inv.balanceDue = Math.max(0, currentDue - body.totalRefund);
          await inv.save({ session });
        }
      }

      await session.commitTransaction();
      return res.status(201).json(savedReturn.toJSON());
    } catch (error: any) {
      await session.abortTransaction();

      const duplicateError =
        (error && typeof error === 'object' && 'code' in error && (error as any).code === 11000) ||
        (error && typeof error.message === 'string' && /duplicate key/i.test(error.message));

      if (duplicateError && attempt < maxAttempts) {
        continue;
      }

      console.error('[POST /sales-returns] failed:', error?.message || error);
      return res.status(400).json({ error: error?.message || 'Failed to create sales return' });
    } finally {
      session.endSession();
    }
  }

  return res.status(500).json({ error: 'Failed to generate unique return number after multiple attempts.' });
});

router.delete('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  const { SalesReturn, Inventory, StockLedger } = req.tenant!.models;
  const session = await Inventory.startSession();
  try {
    session.startTransaction();

    const salesReturn = await SalesReturn.findById(req.params.id).session(session);
    if (!salesReturn) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Sales return not found' });
    }

    await deductInventoryFromSalesReturnReversal(
      Inventory,
      salesReturn.items.map((it: any) => ({
        productId: it.productId,
        netWeight: it.netWeight,
        qty: it.qty || 1,
        name: it.name,
      })),
      session,
      StockLedger,
      salesReturn.returnNo
    );

    await SalesReturn.findByIdAndDelete(req.params.id).session(session);
    await session.commitTransaction();
    res.json({ message: 'Sales return deleted and inventory adjusted' });
  } catch (error: any) {
    await session.abortTransaction();
    console.error('[DELETE /sales-returns] failed:', error.message);
    res.status(400).json({ error: error?.message || 'Failed to delete sales return' });
  } finally {
    session.endSession();
  }
});

export default router;
