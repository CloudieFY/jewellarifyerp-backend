import { Schema, Connection, Model, Document } from 'mongoose';

export interface IAdvance extends Document {
  date: string;
  customerId?: string;
  customerName: string;
  customerMobile: string;
  metal: string;
  purity: string;
  ratePerGram: number;
  amount: number;
  weightLocked: number;
  note?: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const advanceSchema = new Schema<IAdvance>(
  {
    date: { type: String, required: true },
    customerId: { type: String },
    customerName: { type: String, required: true },
    customerMobile: { type: String, required: true },
    metal: { type: String, required: true, enum: ['Gold', 'Silver'] },
    purity: { type: String, required: true },
    ratePerGram: { type: Number, required: true },
    amount: { type: Number, required: true },
    weightLocked: { type: Number, required: true },
    note: { type: String },
    status: { type: String, default: 'Active', enum: ['Active', 'Redeemed', 'Cancelled'] },
  },
  { timestamps: true, collection: 'advances' }
);

export function getAdvanceModel(conn: Connection): Model<IAdvance> {
  return (
    (conn.models.Advance as Model<IAdvance>) || conn.model<IAdvance>('Advance', advanceSchema)
  );
}
