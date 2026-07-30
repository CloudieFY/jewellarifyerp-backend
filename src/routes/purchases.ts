import { Request, Response } from 'express';
import { buildTenantCrudRouter } from './crudFactory';
import { requireTenantAuth } from '../middleware/auth';

const router = buildTenantCrudRouter((models) => models.Purchases, {
  resourceName: 'Purchase',
});

router.patch('/:id/approve', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const Purchases = req.tenant!.models.Purchases;
    const doc = await Purchases.findByIdAndUpdate(
      req.params.id,
      { status: 'Approved', approvedBy: req.tenantAuth!.username, approvedAt: new Date().toISOString(), rejectionReason: '' },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ error: 'Purchase not found' });
    res.json(doc.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to approve purchase' });
  }
});

router.patch('/:id/reject', requireTenantAuth(['owner']), async (req: Request, res: Response) => {
  try {
    const Purchases = req.tenant!.models.Purchases;
    const doc = await Purchases.findByIdAndUpdate(
      req.params.id,
      { status: 'Rejected', approvedBy: req.tenantAuth!.username, approvedAt: new Date().toISOString(), rejectionReason: req.body?.reason || '' },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ error: 'Purchase not found' });
    res.json(doc.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to reject purchase' });
  }
});

router.post('/:id/receive', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const Purchases = req.tenant!.models.Purchases;
    const order = await Purchases.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Purchase Order not found' });
    if (order.docType !== 'Order') return res.status(400).json({ error: 'Only Purchase Orders can be received' });
    if (order.status !== 'Approved') return res.status(400).json({ error: 'Purchase Order must be Approved before it can be received' });

    order.status = 'Received';
    await order.save();

    const entryData = order.toJSON() as any;
    delete entryData._id;
    delete entryData.id;
    delete entryData.createdAt;
    delete entryData.updatedAt;
    const entry = new Purchases({
      ...entryData,
      docType: 'Entry',
      status: 'Completed',
      needsApproval: false,
      linkedDocId: order.id,
    });
    await entry.save();

    res.status(201).json(entry.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to receive purchase order' });
  }
});

export default router;
