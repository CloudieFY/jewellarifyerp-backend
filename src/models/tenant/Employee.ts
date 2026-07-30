import { Schema, Connection, Model, Document } from 'mongoose';

export interface IEmployee extends Document {
  name: string;
  phone?: string;
  role: string;
  salary: number;
  joinDate: string;
  status: string;
  totalPaid: number;
  notes?: string;
  aadhaar?: string;
  pan?: string;
  bankDetails?: string;
  upiId?: string;
  address?: string;
  payments?: any[];
  createdAt: Date;
  updatedAt: Date;
}

const employeeSchema = new Schema<IEmployee>(
  {
    name: { type: String, required: true },
    phone: { type: String },
    role: { type: String, required: true },
    salary: { type: Number, required: true, default: 0 },
    joinDate: { type: String, required: true },
    status: { type: String, default: 'Active' },
    totalPaid: { type: Number, default: 0 },
    notes: { type: String },
    aadhaar: { type: String },
    pan: { type: String },
    bankDetails: { type: String },
    upiId: { type: String },
    address: { type: String },
    payments: { type: Array, default: [] },
  },
  { timestamps: true, strict: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

employeeSchema.index({ createdAt: -1 });
employeeSchema.index({ status: 1 });
employeeSchema.index({ phone: 1 });

employeeSchema.virtual('id').get(function (this: any) {
  return this._id.toHexString();
});

export function getEmployeeModel(conn: Connection): Model<IEmployee> {
  return (
    (conn.models.Employee as Model<IEmployee>) ||
    conn.model<IEmployee>('Employee', employeeSchema)
  );
}
