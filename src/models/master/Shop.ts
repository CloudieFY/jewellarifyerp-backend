import { Schema, Document, Connection, Model, Types } from 'mongoose';

export type ShopPlan = 'trial' | 'basic' | 'standard' | 'premium';
export type ShopStatus = 'active' | 'suspended' | 'expired';

export interface IShop extends Document {
  _id: Types.ObjectId;
  shopId: string;          // string form of _id, duplicated for convenience/URLs
  slug: string;            // human-friendly login id, e.g. "arihant-jewellers"
  shopName: string;
  ownerName?: string;
  email?: string;
  phone?: string;
  logoUrl?: string;
  address?: string;
  gstNumber?: string;
  numberOfShopOwner?: string;
  instaId?: string;
  fbId?: string;
  termsAndConditions?: string;

  // Subscription / plan tracking (manual, set by super admin - no payment gateway)
  plan: ShopPlan;
  status: ShopStatus;
  subscriptionStartDate: Date;
  subscriptionEndDate: Date;

  // The very first login user created for this shop (the "shop admin").
  // Actual credentials live in the tenant DB's User collection; this is
  // just a convenience pointer for the super admin dashboard.
  initialAdminUsername: string;

  dbName: string; // e.g. "shop_64f1a2b3c4d5e6f7a8b9c0d1"

  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const shopSchema = new Schema<IShop>(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    shopName: { type: String, required: true },
    ownerName: { type: String },
    email: { type: String },
    phone: { type: String },
    address: { type: String },
    gstNumber: { type: String },
    logoUrl: { type: String },
    numberOfShopOwner: { type: String },
    instaId: { type: String },
    fbId: { type: String },
    termsAndConditions: { type: String },

    plan: { type: String, enum: ['trial', 'basic', 'standard', 'premium'], default: 'trial' },
    status: { type: String, enum: ['active', 'suspended', 'expired'], default: 'active' },
    subscriptionStartDate: { type: Date, required: true, default: Date.now },
    subscriptionEndDate: { type: Date, required: true },

    initialAdminUsername: { type: String, required: true },

    dbName: { type: String, required: true, unique: true },

    notes: { type: String },
  },
  { timestamps: true }
);

shopSchema.virtual('shopId').get(function (this: IShop) {
  return this._id.toString();
});

shopSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});

export function getShopModel(masterConn: Connection): Model<IShop> {
  return (
    (masterConn.models.Shop as Model<IShop>) || masterConn.model<IShop>('Shop', shopSchema)
  );
}
