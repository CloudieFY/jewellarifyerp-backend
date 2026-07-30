import { Schema, Connection, Model, Document } from 'mongoose';

export interface IRepair extends Document {
  ticketNo: string;
  date: Date;
  customerName: string;
  customerMobile?: string;
  customerMobile2?: string;
  customerAddress?: string;
  category?: string;
  design?: string;
  repairType?: string;
  metal?: 'Gold' | 'Silver' | 'Diamond' | 'Platinum' | 'Other';
  purity?: string;
  itemDescription?: string;
  itemWeight?: number;
  receivedWeight?: number;
  deliveredWeight?: number;
  goldAddedWeight?: number;
  problem?: string;
  estimatedCost?: number;
  actualCost?: number;
  karigarLabourCharge?: number;
  advance?: number;
  expectedDate?: Date;
  deliveryDate?: Date;
  karigarId?: string;
  status: 'Received' | 'In Progress' | 'Ready' | 'Delivered';
  beforePhotoUrl?: string;
  afterPhotoUrl?: string;
  note?: string;
  customerSignature?: string;
  authorizedSignatory?: string;
  createdAt: Date;
  updatedAt: Date;
}

const repairSchema = new Schema<IRepair>(
  {
    ticketNo: { type: String, required: true },
    date: { type: Date, required: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    customerMobile2: { type: String },
    customerAddress: { type: String },
    category: { type: String },
    design: { type: String },
    repairType: { type: String },
    metal: { type: String, default: 'Gold' },
    purity: { type: String, default: '22K (916)' },
    itemDescription: { type: String },
    itemWeight: { type: Number, default: 0 },
    receivedWeight: { type: Number, default: 0 },
    deliveredWeight: { type: Number, default: 0 },
    goldAddedWeight: { type: Number, default: 0 },
    problem: { type: String },
    estimatedCost: { type: Number, default: 0 },
    actualCost: { type: Number, default: 0 },
    karigarLabourCharge: { type: Number, default: 0 },
    advance: { type: Number, default: 0 },
    expectedDate: { type: Date },
    deliveryDate: { type: Date },
    karigarId: { type: String },
    status: { type: String, enum: ['Received', 'In Progress', 'Ready', 'Delivered'], default: 'Received' },
    beforePhotoUrl: { type: String },
    afterPhotoUrl: { type: String },
    note: { type: String },
    customerSignature: { type: String },
    authorizedSignatory: { type: String },
  },
  { timestamps: true }
);

export function getRepairModel(conn: Connection): Model<IRepair> {
  return (conn.models.Repair as Model<IRepair>) || conn.model<IRepair>('Repair', repairSchema);
}
