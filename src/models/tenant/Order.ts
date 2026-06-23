import { Schema, Connection, Model, Document } from 'mongoose';

export interface IOrder extends Document {
  orderNo: string;
  date: string;
  customerName: string;
  customerMobile?: string;
  customerAddress?: string;
  itemDescription: string;
  metal: string;
  purity?: string;
  fixedPrice?: number;
  advancePaid?: number;
  dueDate?: string;
  status: string;
  note?: string;
  customerSignature?: string;
  authorizedSignatory?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<IOrder>(
  {
    orderNo: { type: String, required: true },
    date: { type: String, required: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    customerAddress: { type: String },
    itemDescription: { type: String, required: true },
    metal: { type: String, required: true, default: 'Gold' },
    purity: { type: String },
    fixedPrice: { type: Number, default: 0 },
    advancePaid: { type: Number, default: 0 },
    dueDate: { type: String },
    status: { type: String, default: 'Pending' },
    note: { type: String },
    customerSignature: { type: String },
    authorizedSignatory: { type: String },
  },
  { timestamps: true }
);

orderSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});

export function getOrderModel(conn: Connection): Model<IOrder> {
  return (conn.models.Order as Model<IOrder>) || conn.model<IOrder>('Order', orderSchema);
}
