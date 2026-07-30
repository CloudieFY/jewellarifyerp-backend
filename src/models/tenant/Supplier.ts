import { Schema, Connection, Model, Document } from 'mongoose';

export interface ISupplierTransaction {
  date: string;
  type: 'Credit' | 'Debit';
  kind: 'Weight' | 'Payment';
  metal?: 'Gold' | 'Silver';
  purity?: string;
  weight?: number;
  amount: number;
  paymentMode?: string;
  note?: string;
}

export interface ISupplier extends Document {
  name: string;
  company?: string;
  mobile: string;
  email?: string;
  category?: string;
  gstNumber?: string;
  address?: string;
  companyNo?: string;
  note?: string;
  outstanding: number;
  balanceGold: number;
  balanceSilver: number;
  transactions?: ISupplierTransaction[];
  createdAt: Date;
  updatedAt: Date;
}

const supplierTransactionSchema = new Schema<ISupplierTransaction>({
  date: { type: String, required: true },
  type: { type: String, enum: ['Credit', 'Debit'], required: true },
  kind: { type: String, enum: ['Weight', 'Payment'], default: 'Weight' },
  metal: { type: String, enum: ['Gold', 'Silver'] },
  purity: { type: String },
  weight: { type: Number },
  amount: { type: Number, default: 0 },
  paymentMode: { type: String },
  note: { type: String },
});

const supplierSchema = new Schema<ISupplier>(
  {
    name: { type: String, required: true },
    company: { type: String },
    mobile: { type: String, required: true },
    email: { type: String },
    category: { type: String },
    gstNumber: { type: String },
    address: { type: String },
    companyNo: { type: String },
    note: { type: String },
    outstanding: { type: Number, default: 0 },
    balanceGold: { type: Number, default: 0 },
    balanceSilver: { type: Number, default: 0 },
    transactions: { type: [supplierTransactionSchema], default: [] },
  },
  { timestamps: true }
);

export function getSupplierModel(conn: Connection): Model<ISupplier> {
  return (
    (conn.models.Supplier as Model<ISupplier>) ||
    conn.model<ISupplier>('Supplier', supplierSchema)
  );
}
