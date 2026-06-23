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
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

employeeSchema.virtual('id').get(function (this: any) {
  return this._id.toHexString();
});

export function getEmployeeModel(conn: Connection): Model<IEmployee> {
  return (
    (conn.models.Employee as Model<IEmployee>) ||
    conn.model<IEmployee>('Employee', employeeSchema)
  );
}
