import { Router, Request, Response } from 'express';
import { requireTenantAuth } from '../middleware/auth';
import mongoose from 'mongoose';

const router = Router();

// Get all customers
router.get('/', requireTenantAuth(), async (req: Request, res: Response) => {
  try {
    const customers = await req.tenant!.models.Customer.find().sort({ name: 1 });
    res.json(customers.map(c => c.toJSON()));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Create a new customer
router.post('/', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const { name, phone } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    // Simple phone-based deduplication
    if (phone) {
      const existing = await req.tenant!.models.Customer.findOne({ phone });
      if (existing) {
        return res.status(409).json({ error: 'A customer with this phone number already exists.' });
      }
    }

    const customer = new req.tenant!.models.Customer(req.body);
    const savedCustomer = await customer.save();
    res.status(201).json(savedCustomer.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Update a customer
router.put('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  try {
    const customer = await req.tenant!.models.Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json(customer.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Delete a customer and all their associated data
router.delete('/:id', requireTenantAuth(['owner', 'operator']), async (req: Request, res: Response) => {
  const session = await req.tenant!.models.Customer.startSession();
  session.startTransaction();
  try {
    const customerId = req.params.id;
    const customer = await req.tenant!.models.Customer.findById(customerId).session(session);
    if (!customer) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Delete all associated data
    await req.tenant!.models.Invoice.deleteMany({ customerId }, { session });
    await req.tenant!.models.Order.deleteMany({ customerId }, { session });
    
    // For models that might use phone number instead of customerId
    if (customer.phone) {
      await req.tenant!.models.Order.deleteMany({ customerMobile: customer.phone }, { session });
      await req.tenant!.models.Repair.deleteMany({ customerMobile: customer.phone }, { session });
      await req.tenant!.models.Girvi.deleteMany({ customerMobile: customer.phone }, { session });
    }
    
    await req.tenant!.models.Repair.deleteMany({ customerId }, { session });
    await req.tenant!.models.Girvi.deleteMany({ customerId }, { session });
    await req.tenant!.models.Advance.deleteMany({ customerId }, { session });

    // Finally, delete the customer
    await req.tenant!.models.Customer.findByIdAndDelete(customerId).session(session);

    await session.commitTransaction();
    res.json({ message: 'Customer and all associated data deleted successfully' });
  } catch (error: any) {
    await session.abortTransaction();
    console.error('[DELETE /customers/:id] failed:', error.message);
    res.status(500).json({ error: 'Failed to delete customer and their data' });
  } finally {
    session.endSession();
  }
});

export default router;