import { Schema, Connection, Model, Document } from 'mongoose';

export interface ICustomer extends Document {
  name: string;
  phone?: string;
  phone2?: string;
  address: string;
  gstNumber?: string;
  pan?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<ICustomer>(
  {
    name: { type: String, required: true },
    phone: { type: String },
    phone2: { type: String },
    address: { type: String, required: true },
    gstNumber: { type: String },
    pan: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

export function getCustomerModel(conn: Connection): Model<ICustomer> {
  return (
    (conn.models.Customer as Model<ICustomer>) ||
    conn.model<ICustomer>('Customer', customerSchema)
  );
}
