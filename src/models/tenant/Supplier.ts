import { Schema, Connection, Model, Document } from 'mongoose';

export interface ISupplierTransaction {
  date: string;
  type: 'Credit' | 'Debit';
  metal: 'Gold' | 'Silver';
  weight?: number;
  amount: number;
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
  transactions?: ISupplierTransaction[];
  createdAt: Date;
  updatedAt: Date;
}

const supplierTransactionSchema = new Schema<ISupplierTransaction>({
  date: { type: String, required: true },
  type: { type: String, enum: ['Credit', 'Debit'], required: true },
  metal: { type: String, enum: ['Gold', 'Silver'], required: true },
  weight: { type: Number },
  amount: { type: Number, required: true },
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
