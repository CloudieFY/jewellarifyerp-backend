import { Schema, Connection, Model, Document } from 'mongoose';

export interface IJobwork extends Document {
  jobNo: string;
  date: string;
  karigarId: string;
  karigarName: string;
  itemDescription: string;
  metal: string;
  purity: string;
  issuedWeight: number;
  receivedWeight: number;
  wastage: number;
  makingCharge: number;
  dueDate?: string;
  status: string;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const jobworkSchema = new Schema<IJobwork>(
  {
    jobNo: { type: String, required: true },
    date: { type: String, required: true },
    karigarId: { type: String, required: true },
    karigarName: { type: String, required: true },
    itemDescription: { type: String, required: true },
    metal: { type: String, default: 'Gold' },
    purity: { type: String, default: '22K' },
    issuedWeight: { type: Number, default: 0 },
    receivedWeight: { type: Number, default: 0 },
    wastage: { type: Number, default: 0 },
    makingCharge: { type: Number, default: 0 },
    dueDate: { type: String },
    status: {
      type: String,
      enum: ['Issued', 'In Progress', 'Received', 'Settled'],
      default: 'Issued',
    },
    note: { type: String },
  },
  { timestamps: true }
);

export function getJobworkModel(conn: Connection): Model<IJobwork> {
  return (
    (conn.models.Jobwork as Model<IJobwork>) || conn.model<IJobwork>('Jobwork', jobworkSchema)
  );
}
