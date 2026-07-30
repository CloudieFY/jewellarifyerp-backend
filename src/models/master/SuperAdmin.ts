import { Schema, Document, Connection, Model } from 'mongoose';

export interface ISuperAdmin extends Document {
  username: string;
  passwordHash: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const superAdminSchema = new Schema<ISuperAdmin>(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
  },
  { timestamps: true }
);

superAdminSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    return ret;
  },
});

/**
 * SuperAdmin lives on the MASTER connection (shared across the whole
 * platform), never on a per-shop connection.
 */
export function getSuperAdminModel(masterConn: Connection): Model<ISuperAdmin> {
  return (
    (masterConn.models.SuperAdmin as Model<ISuperAdmin>) ||
    masterConn.model<ISuperAdmin>('SuperAdmin', superAdminSchema)
  );
}
