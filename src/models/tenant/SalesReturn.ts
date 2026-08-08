import { Schema, Connection, Model, Document } from 'mongoose';

export interface ISalesReturnItem {
  productId: string;
  name: string;
  purity?: string;
  netWeight: number;
  ratePerGram: number;
  makingCharge: number;
  gstPct: number;
  qty: number;
  huid?: string;
  returnAmount: number;
}

export interface ISalesReturn extends Document {
  returnNo: string;
  date: Date;
  invoiceId?: string;
  invoiceNumber?: string;
  customerId?: string;
  customerName: string;
  customerMobile?: string;
  items: ISalesReturnItem[];
  subtotal: number;
  gstAmount: number;
  totalRefund: number;
  refundMode: 'Cash' | 'UPI' | 'Card' | 'Adjust Dues' | 'Store Credit';
  reason?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const salesReturnItemSchema = new Schema<ISalesReturnItem>({
  productId: { type: String, required: true },
  name: { type: String, required: true },
  purity: { type: String },
  netWeight: { type: Number, required: true },
  ratePerGram: { type: Number, required: true, default: 0 },
  makingCharge: { type: Number, default: 0 },
  gstPct: { type: Number, default: 0 },
  qty: { type: Number, required: true, default: 1 },
  huid: { type: String },
  returnAmount: { type: Number, required: true, default: 0 },
});

const salesReturnSchema = new Schema<ISalesReturn>(
  {
    returnNo: { type: String, required: true, unique: true },
    date: { type: Date, required: true, default: Date.now },
    invoiceId: { type: String },
    invoiceNumber: { type: String },
    customerId: { type: String },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    items: { type: [salesReturnItemSchema], required: true },
    subtotal: { type: Number, required: true, default: 0 },
    gstAmount: { type: Number, required: true, default: 0 },
    totalRefund: { type: Number, required: true, default: 0 },
    refundMode: {
      type: String,
      enum: ['Cash', 'UPI', 'Card', 'Adjust Dues', 'Store Credit'],
      required: true,
      default: 'Cash',
    },
    reason: { type: String },
    notes: { type: String },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

salesReturnSchema.index({ createdAt: -1 });
salesReturnSchema.index({ invoiceId: 1 });
salesReturnSchema.index({ customerId: 1 });

salesReturnSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});

export function getSalesReturnModel(conn: Connection): Model<ISalesReturn> {
  return (
    (conn.models.SalesReturn as Model<ISalesReturn>) ||
    conn.model<ISalesReturn>('SalesReturn', salesReturnSchema)
  );
}
