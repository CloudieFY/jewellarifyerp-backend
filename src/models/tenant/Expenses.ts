import { Schema, Connection, Model, Document } from 'mongoose';

export interface IExpenses extends Document {
  description: string;
  category: string;
  expenseType?: 'Direct' | 'Indirect';
  amount: number;
  date: string;
  paymentMode?: string;
  payeeName?: string;
  voucherNo?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const expensesSchema = new Schema<IExpenses>(
  {
    description: { type: String, required: true },
    category: { type: String, required: true },
    expenseType: { type: String, enum: ['Direct', 'Indirect'], default: 'Indirect' },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    paymentMode: { type: String, default: 'Cash' },
    payeeName: { type: String },
    voucherNo: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

export function getExpensesModel(conn: Connection): Model<IExpenses> {
  return (
    (conn.models.Expenses as Model<IExpenses>) ||
    conn.model<IExpenses>('Expenses', expensesSchema)
  );
}
