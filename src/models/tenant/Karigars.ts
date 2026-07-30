import { Schema, Connection, Model, Document } from 'mongoose';

export interface IKarigar extends Document {
  name: string;
  mobile: string;
  companyName?: string;
  email?: string;
  category?: string;
  specialty?: string;
  gstNumber?: string;
  address?: string;
  note?: string;
  pendingWeight: number;
  // Login credentials for the karigar to access their own portal.
  // These map to a tenant User record (role: 'karigar') created alongside.
  username?: string;
  createdAt: Date;
  updatedAt: Date;
}

const karigarSchema = new Schema<IKarigar>(
  {
    name: { type: String, required: true },
    mobile: { type: String, required: true },
    companyName: { type: String },
    email: { type: String },
    category: { type: String },
    specialty: { type: String },
    gstNumber: { type: String },
    address: { type: String },
    note: { type: String },
    pendingWeight: { type: Number, default: 0 },
    username: { type: String },
  },
  { timestamps: true }
);

export function getKarigarsModel(conn: Connection): Model<IKarigar> {
  return (
    (conn.models.Karigars as Model<IKarigar>) ||
    conn.model<IKarigar>('Karigars', karigarSchema)
  );
}
