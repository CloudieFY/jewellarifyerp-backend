import { Router, Request, Response } from 'express';
import { Model } from 'mongoose';
import { requireTenantAuth } from '../middleware/auth';
import { IInventory } from '../models/tenant/Inventory';
import { ISalesReturn } from '../models/tenant/SalesReturn';

const router = Router();

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

function normalizeProductId(productId: string) {
  if (!productId || typeof productId !== 'string') return productId;
  if (isManualOrNonInventoryId(productId)) return productId;
  if (productId.includes('__GW_')) {
    return productId.split('__GW_')[0];
  }
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

async function findInventoryItem(
  InventoryModel: Model<IInventory>,
  productId: string,
  itemName: string,
  session: any,
) {
  const rawProductId = productId || '';
  if (isManualOrNonInventoryId(rawProductId)) {
    return null;
  }

  const normalizedProductId = normalizeProductId(rawProductId);
  if (isManualOrNonInventoryId(normalizedProductId)) {
    return null;
  }

  let inventory: any = null;
  // 1. Try findById
  try {
    inventory = await InventoryModel.findById(normalizedProductId).session(session);
  } catch {}

  // 2. Try findOne by _id
  if (!inventory) {
    try {
      inventory = await InventoryModel.findOne({ _id: normalizedProductId }).session(session);
    } catch {}
  }

  // 3. Try findOne by barcode
  if (!inventory) {
    inventory = await InventoryModel.findOne({ barcode: normalizedProductId }).session(session);
  }

  // 4. Try findOne by huid
  if (!inventory) {
    inventory = await InventoryModel.findOne({ huid: normalizedProductId }).session(session);
  }

  // 5. Try findOne by itemCode
  if (!inventory) {
    inventory = await InventoryModel.findOne({ itemCode: normalizedProductId }).session(session);
  }

  // 6. Try findOne by name
  if (!inventory && itemName) {
    inventory = await InventoryModel.findOne({ name: itemName }).session(session);
  }

  return inventory;
}

async function restoreInventoryFromSalesReturn(
  InventoryModel: Model<IInventory>,
  returnItems: Array<{ productId: string; netWeight: number; grossWeight?: number; stoneWeight?: number; qty: number; name: string }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of returnItems) {
    const inventory = await findInventoryItem(InventoryModel, item.productId, item.name, session);

    if (inventory) {
      const restoreQty = item.qty || 1;
      const restoreNetWt = item.netWeight || 0;
      const restoreGrossWt = item.grossWeight || parseGrossWeightFromProductId(item.productId || '') || restoreNetWt;
      const restoreStoneWt = item.stoneWeight || 0;

      inventory.stock = (inventory.stock || 0) + restoreQty;
      inventory.netWeight = Number(((inventory.netWeight || 0) + restoreNetWt).toFixed(3));
      inventory.grossWeight = Number(((inventory.grossWeight || 0) + restoreGrossWt).toFixed(3));
      inventory.stoneWeight = Number(((inventory.stoneWeight || 0) + restoreStoneWt).toFixed(3));
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
            grossWeightChange: restoreGrossWt,
            netWeightChange: restoreNetWt,
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
    } else {
      console.warn(`[SalesReturn] Could not find inventory item to restore for productId: ${item.productId}, name: ${item.name}`);
    }
  }
}

async function deductInventoryFromSalesReturnReversal(
  InventoryModel: Model<IInventory>,
  returnItems: Array<{ productId: string; netWeight: number; grossWeight?: number; stoneWeight?: number; qty: number; name: string }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of returnItems) {
    const inventory = await findInventoryItem(InventoryModel, item.productId, item.name, session);

    if (inventory) {
      const deductQty = item.qty || 1;
      const deductNetWt = item.netWeight || 0;
      const deductGrossWt = item.grossWeight || parseGrossWeightFromProductId(item.productId || '') || deductNetWt;
      const deductStoneWt = item.stoneWeight || 0;

      inventory.stock = Math.max(0, (inventory.stock || 0) - deductQty);
      inventory.netWeight = Math.max(0, Number(((inventory.netWeight || 0) - deductNetWt).toFixed(3)));
      inventory.grossWeight = Math.max(0, Number(((inventory.grossWeight || 0) - deductGrossWt).toFixed(3)));
      inventory.stoneWeight = Math.max(0, Number(((inventory.stoneWeight || 0) - deductStoneWt).toFixed(3)));
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
            grossWeightChange: -deductGrossWt,
            netWeightChange: -deductNetWt,
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

      if (body.invoiceId) {
        const existingReturn = await SalesReturn.findOne({ invoiceId: body.invoiceId }).session(session);
        if (existingReturn) {
          throw new Error(`Invoice ${body.invoiceNumber || ''} has already been returned.`);
        }
      }

      const returnNo = await getNextSalesReturnNumber(SalesReturn, session);
      const salesReturn = new SalesReturn({ ...body, returnNo });
      const savedReturn = await salesReturn.save({ session });

      if (body.invoiceId) {
        const inv = await Invoice.findById(body.invoiceId).session(session);
        if (inv) {
          (inv as any).isReturned = true;
          await inv.save({ session });
        }
      }

      // 1. Restore Inventory Stock (grossWeight + stoneWeight + netWeight + qty)
      await restoreInventoryFromSalesReturn(
        Inventory,
        savedReturn.items.map((it: any) => ({
          productId: it.productId,
          netWeight: it.netWeight,
          grossWeight: (it as any).grossWeight || it.netWeight,
          stoneWeight: (it as any).stoneWeight || 0,
          qty: it.qty || 1,
          name: it.name,
        })),
        session,
        StockLedger,
        returnNo
      );

      // 2. Adjust Dues on Invoice and Customer
      if (body.totalRefund && body.totalRefund > 0) {
        let remainingRefund = body.totalRefund;

        if (body.invoiceId) {
          const inv = await Invoice.findById(body.invoiceId).session(session);
          if (inv) {
            const currentDue = inv.balanceDue || 0;
            const appliedDeduct = Math.min(currentDue, remainingRefund);
            const newDue = Math.max(0, currentDue - remainingRefund);
            inv.balanceDue = newDue;
            if (newDue <= 0) {
              inv.isPaid = true;
            }
            await inv.save({ session });
            remainingRefund = Math.max(0, remainingRefund - appliedDeduct);
          }
        }

        if (remainingRefund > 0 && (body.customerId || savedReturn.customerId)) {
          const custId = body.customerId || savedReturn.customerId;
          const openInvoices = await Invoice.find({
            customerId: custId,
            balanceDue: { $gt: 0 }
          }).session(session);

          for (const openInv of openInvoices) {
            if (remainingRefund <= 0) break;
            const cDue = openInv.balanceDue || 0;
            if (cDue > 0) {
              const deduct = Math.min(cDue, remainingRefund);
              const nDue = cDue - deduct;
              openInv.balanceDue = nDue;
              if (nDue <= 0) {
                openInv.isPaid = true;
              }
              await openInv.save({ session });
              remainingRefund -= deduct;
            }
          }
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
  const { SalesReturn, Invoice } = req.tenant!.models;
  try {
    const salesReturn = await SalesReturn.findById(req.params.id);
    if (!salesReturn) {
      return res.status(404).json({ error: 'Sales return not found' });
    }

    if (salesReturn.invoiceId) {
      const inv = await Invoice.findById(salesReturn.invoiceId);
      if (inv) {
        (inv as any).isReturned = false;
        if (salesReturn.totalRefund && salesReturn.totalRefund > 0) {
          const restoredDue = (inv.balanceDue || 0) + salesReturn.totalRefund;
          inv.balanceDue = restoredDue;
          inv.isPaid = restoredDue <= 0;
          await inv.save();
        }
      }
    }

    await SalesReturn.findByIdAndDelete(req.params.id);
    res.json({ message: 'Sales return record deleted and dues updated.' });
  } catch (error: any) {
    console.error('[DELETE /sales-returns] failed:', error.message);
    res.status(400).json({ error: error?.message || 'Failed to delete sales return' });
  }
});

export default router;
