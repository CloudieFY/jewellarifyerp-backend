import { Router, Request, Response } from 'express';
import { Model } from 'mongoose';
import { requireTenantAuth } from '../middleware/auth';
import { IInventory } from '../models/tenant/Inventory';
import { IInvoice } from '../models/tenant/Invoice';

const router = Router();

function normalizeInvoiceProductId(productId: string) {
  if (!productId || typeof productId !== 'string') return productId;
  if (productId.startsWith('manual-')) return productId;
  if (productId.includes('__GW_')) {
    return productId.split('__GW_')[0];
  }
  return productId;
}

async function getNextInvoiceNumber(
  InvoiceModel: Model<IInvoice>,
  type: 'GST' | 'NON-GST',
  session: any,
) {
  const prefix = type === 'GST' ? 'GST-' : 'INV-';
  const regex = type === 'GST' ? /^GST-(\d+)$/ : /^INV-(\d+)$/;
  const invoices = await InvoiceModel.find({ type }).select('number').session(session).lean();

  const used = new Set<number>();
  for (const invoice of invoices) {
    const match = typeof invoice.number === 'string' ? invoice.number.match(regex) : null;
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

async function applyInventoryDeductionFromInvoiceItems(
  InventoryModel: Model<IInventory>,
  invoiceItems: Array<{ productId: string; netWeight: number; qty: number }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of invoiceItems) {
    const normalizedProductId = normalizeInvoiceProductId(item.productId || "");
    if (!normalizedProductId || normalizedProductId.startsWith('manual')) {
      continue;
    }

    let inventory: any = null;
    try {
      inventory = await InventoryModel.findById(normalizedProductId).session(session);
    } catch {
      // ignore cast errors
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

    if (!inventory) {
      throw new Error(`Inventory item not found for productId: ${item.productId}`);
    }

    const deductStock = item.qty;
    const deductWt = item.netWeight * item.qty;

    if (inventory.stock < deductStock) {
      throw new Error(`Insufficient stock for ${inventory._id}`);
    }
    if (inventory.netWeight < deductWt) {
      throw new Error(`Insufficient wt for ${inventory._id}`);
    }

    inventory.stock = inventory.stock - deductStock;
    inventory.netWeight = inventory.netWeight - deductWt;
    await inventory.save({ session });

    if (StockLedgerModel) {
      try {
        const ledgerEntry = new StockLedgerModel({
          date: new Date().toISOString().slice(0, 10),
          itemId: inventory._id,
          itemCode: inventory.itemCode || inventory.barcode || inventory._id.toString(),
          itemName: inventory.name,
          transactionType: 'SALE',
          qtyChange: -deductStock,
          grossWeightChange: -(inventory.grossWeight || 0),
          netWeightChange: -deductWt,
          balanceQty: inventory.stock,
          balanceGrossWeight: inventory.grossWeight,
          balanceNetWeight: inventory.netWeight,
          referenceNo: refNo || '',
          remarks: 'Sales Invoice Stock Deduction',
        });
        await ledgerEntry.save({ session });
      } catch (e) {
        // non-blocking for legacy
      }
    }
  }
}

async function restoreInventoryFromInvoiceItems(
  InventoryModel: Model<IInventory>,
  invoiceItems: Array<{ productId: string; netWeight: number; qty: number }>,
  session: any,
  StockLedgerModel?: any,
  refNo?: string,
) {
  for (const item of invoiceItems) {
    const normalizedProductId = normalizeInvoiceProductId(item.productId || "");
    if (!normalizedProductId || normalizedProductId.startsWith('manual')) {
      continue;
    }

    let inventory: any = null;
    try {
      inventory = await InventoryModel.findById(normalizedProductId).session(session);
    } catch {
      // ignore cast errors
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
    if (!inventory) continue; // skip if not found during restoration

    const restoreStock = item.qty;
    const restoreWt = item.netWeight * item.qty;

    inventory.stock = inventory.stock + restoreStock;
    inventory.netWeight = inventory.netWeight + restoreWt;
    await inventory.save({ session });

    if (StockLedgerModel) {
      try {
        const ledgerEntry = new StockLedgerModel({
          date: new Date().toISOString().slice(0, 10),
          itemId: inventory._id,
          itemCode: inventory.itemCode || inventory.barcode || inventory._id.toString(),
          itemName: inventory.name,
          transactionType: 'RETURN',
          qtyChange: restoreStock,
          grossWeightChange: inventory.grossWeight || 0,
          netWeightChange: restoreWt,
          balanceQty: inventory.stock,
          balanceGrossWeight: inventory.grossWeight,
          balanceNetWeight: inventory.netWeight,
          referenceNo: refNo || '',
          remarks: 'Sales Invoice Return / Deletion',
        });
        await ledgerEntry.save({ session });
      } catch (e) {
        // non-blocking
      }
    }
  }
}

router.get('/', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const invoices = await req.tenant!.models.Invoice.find().sort({ createdAt: -1 });
    res.json(invoices.map((i) => i.toJSON()));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const invoice = await req.tenant!.models.Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice.toJSON());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.post('/', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  const { Invoice, Inventory, StockLedger } = req.tenant!.models;

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
      delete body.number;

      if (body.createdAt) {
        body.createdAt = new Date(body.createdAt);
      }

      const invoiceNumber = await getNextInvoiceNumber(Invoice, body.type, session);
      const invoice = new Invoice({ ...body, number: invoiceNumber });
      if (body.createdAt) {
        invoice.createdAt = new Date(body.createdAt);
      }
      const savedInvoice = await invoice.save({ session });

      await applyInventoryDeductionFromInvoiceItems(
        Inventory,
        savedInvoice.items.map((it: any) => ({
          productId: it.productId,
          netWeight: it.netWeight,
          qty: it.qty,
        })),
        session,
        StockLedger,
        invoiceNumber
      );

      await session.commitTransaction();
      return res.status(201).json(savedInvoice.toJSON());
    } catch (error: any) {
      await session.abortTransaction();

      const duplicateError =
        (error && typeof error === 'object' && 'code' in error && (error as any).code === 11000) ||
        (error && typeof error.message === 'string' && /duplicate key/i.test(error.message));

      if (duplicateError && attempt < maxAttempts) {
        continue;
      }

      console.error('[POST /invoices] failed:', error?.message || error);
      return res.status(400).json({ error: error?.message || 'Failed to create invoice' });
    } finally {
      session.endSession();
    }
  }

  return res.status(500).json({ error: 'Failed to generate a unique invoice number after multiple attempts.' });
});

router.put('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData._id;

    if (updateData.createdAt) {
      updateData.createdAt = new Date(updateData.createdAt);
    }

    const invoice = await req.tenant!.models.Invoice.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  const { Invoice, Inventory, StockLedger } = req.tenant!.models;
  const session = await Inventory.startSession();
  try {
    session.startTransaction();

    const invoice = await Invoice.findById(req.params.id).session(session);
    if (!invoice) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Invoice not found' });
    }

    await restoreInventoryFromInvoiceItems(
      Inventory,
      invoice.items.map((it: any) => ({
        productId: it.productId,
        netWeight: it.netWeight,
        qty: it.qty,
      })),
      session,
      StockLedger,
      invoice.number
    );

    await Invoice.findByIdAndDelete(req.params.id).session(session);
    await session.commitTransaction();
    res.json({ message: 'Invoice deleted and inventory restored' });
  } catch (error: any) {
    await session.abortTransaction();
    console.error('[DELETE /invoices] failed:', error.message);
    res.status(400).json({ error: error?.message || 'Failed to delete invoice' });
  } finally {
    session.endSession();
  }
});

export default router;
