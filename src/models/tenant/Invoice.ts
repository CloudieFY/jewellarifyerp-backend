import { Schema, Connection, Model, Document } from 'mongoose';

interface IInvoiceItem {
  productId: string;
  name: string;
  purity: string;
  netWeight: number;
  ratePerGram: number;
  makingCharge: number;
  stoneCharge: number;
  gstPct: number;
  qty: number;
}

interface IInvoicePayment {
  date: Date;
  amount: number;
  mode: string;
  note?: string;
}

export interface IInvoice extends Document {
  number: string;
  type: 'GST' | 'NON-GST';
  customerId?: string;
  customerName: string;
  customerMobile?: string;
  items: IInvoiceItem[];
  discount: number;
  oldGoldAmount: number;
  paymentMode: 'Cash' | 'UPI' | 'Card' | 'EMI';
  subtotal: number;
  gstAmount: number;
  total: number;
  amountPaid?: number;
  balanceDue?: number;
  payments: IInvoicePayment[];
  customerAddress?: string;
  customerSignature?: string;
  authorizedSignatory?: string;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceItemSchema = new Schema<IInvoiceItem>({
  productId: { type: String, required: true },
  name: { type: String, required: true },
  purity: { type: String, required: true },
  netWeight: { type: Number, required: true },
  ratePerGram: { type: Number, required: true },
  makingCharge: { type: Number, required: true },
  stoneCharge: { type: Number, required: true },
  gstPct: { type: Number, required: true },
  qty: { type: Number, required: true },
});

const invoicePaymentSchema = new Schema<IInvoicePayment>({
  date: { type: Date, required: true, default: Date.now },
  amount: { type: Number, required: true },
  mode: { type: String, required: true },
  note: { type: String },
});

const invoiceSchema = new Schema<IInvoice>(
  {
    number: { type: String, required: true, unique: true },
    type: { type: String, enum: ['GST', 'NON-GST'], required: true },
    customerId: { type: String },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    items: { type: [invoiceItemSchema], required: true },
    discount: { type: Number, required: true, default: 0 },
    oldGoldAmount: { type: Number, required: true, default: 0 },
    paymentMode: { type: String, enum: ['Cash', 'UPI', 'Card', 'EMI'], required: true },
    subtotal: { type: Number, required: true },
    gstAmount: { type: Number, required: true },
    total: { type: Number, required: true },
    amountPaid: { type: Number },
    balanceDue: { type: Number },
    payments: { type: [invoicePaymentSchema], default: [] },
    customerAddress: { type: String },
    customerSignature: { type: String },
    authorizedSignatory: { type: String },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

export function getInvoiceModel(conn: Connection): Model<IInvoice> {
  return (
    (conn.models.Invoice as Model<IInvoice>) || conn.model<IInvoice>('Invoice', invoiceSchema)
  );
}
