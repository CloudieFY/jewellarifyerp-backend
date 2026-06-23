import { Schema, Connection, Model, Document } from 'mongoose';

export interface IPurchases extends Document {
  billNo: string;
  date: string;
  supplierId?: string;
  supplierName: string;
  metal: string;
  purity?: string;
  weight: number;
  ratePerGram: number;
  makingCharge: number;
  gstPct: number;
  total: number;
  paymentMode: string;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const purchasesSchema = new Schema<IPurchases>(
  {
    billNo: { type: String, required: true },
    date: { type: String, required: true },
    supplierId: { type: String },
    supplierName: { type: String, required: true },
    metal: { type: String, required: true, default: 'Gold' },
    purity: { type: String },
    weight: { type: Number, required: true },
    ratePerGram: { type: Number, required: true },
    makingCharge: { type: Number, default: 0 },
    gstPct: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMode: { type: String, default: 'Cash' },
    note: { type: String },
  },
  { timestamps: true }
);

export function getPurchasesModel(conn: Connection): Model<IPurchases> {
  return (
    (conn.models.Purchases as Model<IPurchases>) ||
    conn.model<IPurchases>('Purchases', purchasesSchema)
  );
}
