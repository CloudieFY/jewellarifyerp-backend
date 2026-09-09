import { Schema, Document, Connection, Model, Types } from 'mongoose';

export type ShopPlan = 'spark' | 'hero' | 'prime' | 'custom' | 'trial' | 'basic' | 'standard' | 'premium';
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
  invoiceSettings?: Record<string, any>;

  // Subscription / plan tracking (manual, set by super admin - no payment gateway)
  plan: ShopPlan;
  status: ShopStatus;
  subscriptionStartDate: Date;
  subscriptionEndDate: Date;

  // Module and page level feature access controls
  allowedModules?: string[];
  allowedPages?: string[];

  // The very first login users created for this shop (owner + operator).
  // Actual credentials live in the tenant DB's User collection; these are
  // just convenience pointers for the super admin dashboard.
  initialAdminUsername: string;
  initialOperatorUsername?: string;

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
    invoiceSettings: { type: Schema.Types.Mixed, default: {} },

    plan: {
      type: String,
      enum: ['spark', 'hero', 'prime', 'custom', 'trial', 'basic', 'standard', 'premium'],
      default: 'spark',
    },
    status: { type: String, enum: ['active', 'suspended', 'expired'], default: 'active' },
    subscriptionStartDate: { type: Date, required: true, default: Date.now },
    subscriptionEndDate: { type: Date, required: true },

    allowedModules: { type: [String], default: [] },
    allowedPages: { type: [String], default: [] },

    initialAdminUsername: { type: String, required: true },
    initialOperatorUsername: { type: String },

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
