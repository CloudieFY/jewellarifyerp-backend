import mongoose, { Schema, Document, Connection } from 'mongoose';

export interface IDemoRequest extends Document {
  name: string;
  shopName: string;
  phone: string;
  email?: string;
  address?: string;
  status: 'Pending' | 'Contacted' | 'Closed';
  createdAt: Date;
  updatedAt: Date;
}

const DemoRequestSchema: Schema = new Schema({
  name: { type: String, required: true },
  shopName: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  address: { type: String },
  status: { type: String, enum: ['Pending', 'Contacted', 'Closed'], default: 'Pending' },
}, { timestamps: true });

export const getDemoRequestModel = (connection: Connection) => connection.model<IDemoRequest>('DemoRequest', DemoRequestSchema);