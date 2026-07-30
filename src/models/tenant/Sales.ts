import { Schema, Connection, Model, Document } from 'mongoose';

export interface ISales extends Document {
  customerId: string;
  items: Array<{
    itemName: string;
    quantity: number;
    rate: number;
    amount: number;
  }>;
  totalAmount: number;
  status: 'pending' | 'completed' | 'cancelled';
  paymentStatus: 'pending' | 'paid' | 'partial';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const salesSchema = new Schema<ISales>(
  {
    customerId: { type: String, required: true },
    items: [
      {
        itemName: { type: String, required: true },
        quantity: { type: Number, required: true },
        rate: { type: Number, required: true },
        amount: { type: Number, required: true },
      },
    ],
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'partial'], default: 'pending' },
    notes: { type: String },
  },
  { timestamps: true }
);

export function getSalesModel(conn: Connection): Model<ISales> {
  return (conn.models.Sales as Model<ISales>) || conn.model<ISales>('Sales', salesSchema);
}
