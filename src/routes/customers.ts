import { Router, Request, Response } from 'express';
import { requireTenantAuth } from '../middleware/auth';

const router = Router();

// Helper to strip dummy phone placeholder values before sending to client
const cleanCustomer = (doc: any) => {
  const obj = doc.toJSON ? doc.toJSON() : { ...doc };
  if (obj.phone && obj.phone.startsWith('no_phone_')) {
    obj.phone = '';
  }
  if (obj.phone2 && obj.phone2.startsWith('no_phone2_')) {
    obj.phone2 = '';
  }
  return obj;
};

router.get('/', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const customers = await req.tenant!.models.Customer.find().sort({ createdAt: -1 });
    res.json(customers.map(cleanCustomer));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

router.get('/:id', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const customer = await req.tenant!.models.Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(cleanCustomer(customer));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

router.post('/', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const customerData = { ...req.body };
    delete customerData.id;
    delete customerData._id;

    if (!customerData.phone || customerData.phone.trim() === '') {
      customerData.phone = `no_phone_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (!customerData.phone2 || customerData.phone2.trim() === '') {
      customerData.phone2 = `no_phone2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    const customer = new req.tenant!.models.Customer(customerData);
    await customer.save();
    res.status(201).json(cleanCustomer(customer));
  } catch (error: any) {
    console.error('[Customers] create error:', error.message);
    res.status(400).json({ error: error?.message || 'Bad Request', details: error?.errors || undefined });
  }
});

router.put('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData._id;

    if (updateData.phone !== undefined && updateData.phone.trim() === '') {
      updateData.phone = `no_phone_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (updateData.phone2 !== undefined && updateData.phone2.trim() === '') {
      updateData.phone2 = `no_phone2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    const customer = await req.tenant!.models.Customer.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(cleanCustomer(customer));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const customer = await req.tenant!.models.Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json({ message: 'Customer deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

export default router;
