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
  expectedGrossWeight?: number;
  expectedNetWeight?: number;
  sizeLength?: string;
  hallmarkRequired?: boolean;
  rateLockStatus?: 'Locked' | 'Open';
  lockedGoldRate?: number;
  oldGoldWeight?: number;
  oldGoldPurity?: string;
  oldGoldValuation?: number;
  makingCharge?: number;
  wastagePct?: number;
  estimatedTotalAmount?: number;
  fixedPrice?: number;
  advancePaid?: number;
  karigarId?: string;
  dueDate?: string;
  status: string;
  note?: string;
  sampleImageUrl?: string;
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
    purity: { type: String, default: '22K' },
    expectedGrossWeight: { type: Number, default: 0 },
    expectedNetWeight: { type: Number, default: 0 },
    sizeLength: { type: String },
    hallmarkRequired: { type: Boolean, default: true },
    rateLockStatus: { type: String, default: 'Locked' },
    lockedGoldRate: { type: Number, default: 0 },
    oldGoldWeight: { type: Number, default: 0 },
    oldGoldPurity: { type: String, default: '22K' },
    oldGoldValuation: { type: Number, default: 0 },
    makingCharge: { type: Number, default: 0 },
    wastagePct: { type: Number, default: 0 },
    estimatedTotalAmount: { type: Number, default: 0 },
    fixedPrice: { type: Number, default: 0 },
    advancePaid: { type: Number, default: 0 },
    karigarId: { type: String, default: '' },
    dueDate: { type: String },
    status: { type: String, default: 'Pending' },
    note: { type: String },
    sampleImageUrl: { type: String },
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
