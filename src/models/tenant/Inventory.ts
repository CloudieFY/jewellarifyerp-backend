import { Schema, Connection, Model, Document } from 'mongoose';

export interface IInventory extends Document {
  name: string;
  category: string;
  subcategory?: string;
  note?: string;
  huid?: string;
  purity: string;
  grossWeight: number;
  netWeight: number;
  stoneWeight: number;
  makingCharge: number;
  gstPct: number;
  stock: number;
  barcode?: string;
  imageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const inventorySchema = new Schema<IInventory>(
  {
    name: { type: String, required: true },
    category: { type: String, required: true, default: 'Gold' },
    subcategory: { type: String },
    note: { type: String },
    huid: { type: String },
    purity: { type: String, default: '22K' },
    grossWeight: { type: Number, required: true, default: 0 },
    netWeight: { type: Number, required: true, default: 0 },
    stoneWeight: { type: Number, required: true, default: 0 },
    makingCharge: { type: Number, required: true, default: 500 },
    gstPct: { type: Number, required: true, default: 3 },
    stock: { type: Number, required: true, default: 1 },
    barcode: { type: String },
    imageUrl: { type: String },
  },
  { timestamps: true }
);

export function getInventoryModel(conn: Connection): Model<IInventory> {
  return (
    (conn.models.Inventory as Model<IInventory>) ||
    conn.model<IInventory>('Inventory', inventorySchema)
  );
}
