import { Schema, Connection, Model, Document } from 'mongoose';

export interface IPurchases extends Document {
  billNo: string;
  date: string;
  supplierId?: string;
  supplierName?: string;
  supplierGstin?: string;
  metal: string;
  purity?: string;
  hsnCode?: string;
  weight: number;
  ratePerGram: number;
  makingCharge: number;
  taxableValue: number;
  gstPct: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  paymentMode: string;
  note?: string;
  docType: string;
  category: string;
  status: string;
  needsApproval: boolean;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  linkedDocId?: string;
  customerId?: string;
  customerName?: string;
  deductionPct?: number;
  createdAt: Date;
  updatedAt: Date;
}

const purchasesSchema = new Schema<IPurchases>(
  {
    billNo: { type: String, required: true },
    date: { type: String, required: true },
    supplierId: { type: String },
    supplierName: { type: String },
    supplierGstin: { type: String },
    metal: { type: String, required: true, default: 'Gold' },
    purity: { type: String },
    hsnCode: { type: String },
    weight: { type: Number, required: true },
    ratePerGram: { type: Number, required: true },
    makingCharge: { type: Number, default: 0 },
    taxableValue: { type: Number, default: 0 },
    gstPct: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMode: { type: String, default: 'Cash' },
    note: { type: String },
    docType: { type: String, enum: ['Entry', 'Order', 'Return', 'OldGold'], default: 'Entry' },
    category: { type: String, enum: ['Metal', 'Diamond', 'Stone'], default: 'Metal' },
    status: { type: String, default: 'Completed' },
    needsApproval: { type: Boolean, default: false },
    approvedBy: { type: String },
    approvedAt: { type: String },
    rejectionReason: { type: String },
    linkedDocId: { type: String },
    customerId: { type: String },
    customerName: { type: String },
    deductionPct: { type: Number },
  },
  { timestamps: true }
);

purchasesSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});

export function getPurchasesModel(conn: Connection): Model<IPurchases> {
  return (
    (conn.models.Purchases as Model<IPurchases>) ||
    conn.model<IPurchases>('Purchases', purchasesSchema)
  );
}
