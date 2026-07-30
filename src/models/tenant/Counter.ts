import { Schema, Connection, Model, Document } from 'mongoose';

export interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);

export function getCounterModel(conn: Connection): Model<ICounter> {
  return (conn.models.Counter as Model<ICounter>) || conn.model<ICounter>('Counter', counterSchema);
}
