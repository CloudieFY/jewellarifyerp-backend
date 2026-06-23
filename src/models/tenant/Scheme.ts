import { Schema, Connection, Model, Document } from 'mongoose';

export interface IScheme extends Document {
  schemeNo: string;
  date: string;
  customerName: string;
  customerMobile?: string;
  planName: string;
  monthlyAmount: number;
  tenureMonths: number;
  paidMonths: number;
  totalPaid: number;
  maturityDate?: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const schemeSchema = new Schema<IScheme>(
  {
    schemeNo: { type: String, required: true },
    date: { type: String, required: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    planName: { type: String, required: true },
    monthlyAmount: { type: Number, required: true },
    tenureMonths: { type: Number, required: true },
    paidMonths: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    maturityDate: { type: String },
    status: { type: String, default: 'Active' },
  },
  { timestamps: true }
);

export function getSchemeModel(conn: Connection): Model<IScheme> {
  return (conn.models.Scheme as Model<IScheme>) || conn.model<IScheme>('Scheme', schemeSchema);
}
