import { Schema, Document, Connection, Model } from 'mongoose';

/**
 * Each shop's own database has its own User collection. These are the
 * people who log into THIS shop (the owner/admin, a GST operator, or a
 * karigar). Passwords are hashed with bcrypt for login verification - never
 * stored in plain text.
 *
 * passwordEncrypted holds a REVERSIBLE copy of the password (see
 * ../../utils/passwordCrypto.ts), set alongside the hash any time a password
 * is created or reset, solely so the superadmin panel can display a shop's
 * current password on request. It is never used for login and never sent to
 * the tenant app itself (see toJSON below) — only a dedicated superadmin
 * endpoint reads and decrypts it.
 */

export type TenantUserRole = 'owner' | 'operator' | 'karigar';

export interface ITenantUser extends Document {
  username: string;
  passwordHash: string;
  passwordEncrypted?: string;
  name: string;
  role: TenantUserRole;
  karigarRefId?: string; // if role === 'karigar', links to the Karigars doc
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tenantUserSchema = new Schema<ITenantUser>(
  {
    username: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    passwordEncrypted: { type: String, select: false },
    name: { type: String, required: true },
    role: { type: String, enum: ['owner', 'operator', 'karigar'], required: true },
    karigarRefId: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

tenantUserSchema.index({ username: 1 }, { unique: true });

tenantUserSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.passwordEncrypted;
    return ret;
  },
});

export function getTenantUserModel(conn: Connection): Model<ITenantUser> {
  return (
    (conn.models.User as Model<ITenantUser>) || conn.model<ITenantUser>('User', tenantUserSchema)
  );
}
