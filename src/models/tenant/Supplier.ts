import { Schema, Connection, Model, Document } from 'mongoose';

export interface ISupplierTransaction {
  date: string;
  type: 'Credit' | 'Debit';
  kind: 'Weight' | 'Payment' | 'Dual';
  metal?: 'Gold' | 'Silver' | 'Both';
  purity?: string;
  weight?: number;
  goldWeight?: number;
  silverWeight?: number;
  amount: number;
  paymentMode?: string;
  refNo?: string;
  note?: string;
}

export interface ISupplier extends Document {
  name: string;
  acNo?: string;
  group?: string;
  company?: string;
  mobile: string;
  phone?: string;
  email?: string;
  category?: string;
  gstNumber?: string;
  pan?: string;
  address?: string;
  location?: string;
  city?: string;
  state?: string;
  pin?: string;
  country?: string;
  occupation?: string;
  refBy?: string;
  website?: string;
  dob?: string;
  anniversary?: string;
  companyNo?: string;
  taxNo?: string;
  tcs?: number;
  tds?: number;
  uidNo?: string;
  cstNo?: string;
  note?: string;
  openingBalanceGold?: number;
  openingBalanceGoldType?: 'Dr' | 'Cr';
  openingBalanceSilver?: number;
  openingBalanceSilverType?: 'Dr' | 'Cr';
  openingBalanceAmount?: number;
  openingBalanceAmountType?: 'Dr' | 'Cr';
  openingBalanceDate?: string;
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
  kind: { type: String, enum: ['Weight', 'Payment', 'Dual'], default: 'Weight' },
  metal: { type: String },
  purity: { type: String },
  weight: { type: Number },
  goldWeight: { type: Number },
  silverWeight: { type: Number },
  amount: { type: Number, default: 0 },
  paymentMode: { type: String },
  refNo: { type: String },
  note: { type: String },
});

const supplierSchema = new Schema<ISupplier>(
  {
    name: { type: String, required: true },
    acNo: { type: String },
    group: { type: String },
    company: { type: String },
    mobile: { type: String, required: true },
    phone: { type: String },
    email: { type: String },
    category: { type: String },
    gstNumber: { type: String },
    pan: { type: String },
    address: { type: String },
    location: { type: String },
    city: { type: String },
    state: { type: String },
    pin: { type: String },
    country: { type: String },
    occupation: { type: String },
    refBy: { type: String },
    website: { type: String },
    dob: { type: String },
    anniversary: { type: String },
    companyNo: { type: String },
    taxNo: { type: String },
    tcs: { type: Number },
    tds: { type: Number },
    uidNo: { type: String },
    cstNo: { type: String },
    note: { type: String },
    openingBalanceGold: { type: Number },
    openingBalanceGoldType: { type: String },
    openingBalanceSilver: { type: Number },
    openingBalanceSilverType: { type: String },
    openingBalanceAmount: { type: Number },
    openingBalanceAmountType: { type: String },
    openingBalanceDate: { type: String },
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
