import { Router, Request, Response } from 'express';
import { Model } from 'mongoose';
import { requireTenantAuth } from '../middleware/auth';
import { IInventory } from '../models/tenant/Inventory';

const router = Router();

function normalizeInvoiceProductId(productId: string) {
  if (!productId || typeof productId !== 'string') return productId;
  if (productId.startsWith('manual-')) return productId;
  if (productId.includes('__GW_')) {
    return productId.split('__GW_')[0];
  }
  return productId;
}

async function applyInventoryDeductionFromInvoiceItems(
  InventoryModel: Model<IInventory>,
  invoiceItems: Array<{ productId: string; netWeight: number; qty: number }>,
  session: any,
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
  }
}

async function restoreInventoryFromInvoiceItems(
  InventoryModel: Model<IInventory>,
  invoiceItems: Array<{ productId: string; netWeight: number; qty: number }>,
  session: any,
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
  const { Invoice, Inventory } = req.tenant!.models;

  // Multi-document transactions require the session to be opened on the
  // SAME connection the models are bound to - which is exactly what
  // req.tenant.models gives us (each tenant has its own connection).
  const session = await Inventory.startSession();
  try {
    session.startTransaction();
    const body = { ...req.body };
    delete body.id;
    delete body._id;

    const invoice = new Invoice(body);
    const savedInvoice = await invoice.save({ session });

    await applyInventoryDeductionFromInvoiceItems(
      Inventory,
      savedInvoice.items.map((it: any) => ({
        productId: it.productId,
        netWeight: it.netWeight,
        qty: it.qty,
      })),
      session,
    );

    await session.commitTransaction();
    res.status(201).json(savedInvoice.toJSON());
  } catch (error: any) {
    await session.abortTransaction();
    console.error('[POST /invoices] failed:', error.message);
    res.status(400).json({ error: error?.message || 'Failed to create invoice' });
  } finally {
    session.endSession();
  }
});

router.put('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData._id;
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
  const { Invoice, Inventory } = req.tenant!.models;
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
