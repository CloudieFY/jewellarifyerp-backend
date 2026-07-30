import { Schema, Connection, Model, Document } from 'mongoose';

export interface IStoneDetail {
  name: string;
  pcs: number;
  weight: number;
  rate: number;
  amount: number;
}

export interface IDiamondDetail {
  shape: string;
  color: string;
  clarity: string;
  weight: number;
  pcs: number;
  rate: number;
  certNo?: string;
  amount?: number;
}

export interface IInventory extends Document {
  // Basic Info
  name: string;
  itemCode?: string;
  barcode?: string;
  qrCode?: string;
  sku?: string;
  category: string;
  subcategory?: string;
  brand?: string;
  collectionName?: string;
  productType?: string;
  designNo?: string;
  modelNo?: string;
  note?: string;

  // Jewellery Details
  metalType: string; // Gold, Silver, Diamond, Platinum, Gemstone
  purity: string; // 24K, 22K, 20K, 18K, 14K, 925, 999
  huid?: string;
  hallmarkCertified?: boolean;
  metalColor?: string; // Yellow, White, Rose, Dual Tone
  gender?: string; // Men, Women, Kids, Unisex

  // Weight Details
  grossWeight: number;
  stoneWeight: number;
  diamondWeight?: number;
  otherWeight?: number;
  netWeight: number;

  // Stone & Diamond Sub-arrays
  stones?: IStoneDetail[];
  diamonds?: IDiamondDetail[];

  // Pricing & Costing
  purchaseRate?: number;
  metalRate?: number;
  makingChargeType?: 'per_gram' | 'percentage' | 'fixed';
  makingCharge: number; // For backward compat
  makingChargePct?: number;
  wastagePct?: number;
  stoneCost?: number;
  diamondCost?: number;
  otherCharges?: number;
  costPrice?: number;
  sellingPrice?: number;
  minSellingPrice?: number;
  mrp?: number;
  ratePerGram?: number; // Legacy

  // GST
  hsnCode?: string;
  gstPct: number;
  gstType?: 'Inclusive' | 'Exclusive';

  // Stock & Limits
  stock: number;
  availableStock?: number;
  reservedStock?: number;
  minStock?: number;
  maxStock?: number;
  reorderLevel?: number;
  allowNegativeStock?: boolean;

  // Location
  branch?: string;
  godown?: string;
  rack?: string;
  shelf?: string;
  tray?: string;
  locker?: string;

  // Supplier
  defaultSupplierId?: string;
  supplierItemCode?: string;
  leadTimeDays?: number;

  // Manufacturing
  isManufactured?: boolean;
  bom?: string;
  labourCharge?: number;
  castingCharge?: number;
  polishingCharge?: number;
  settingCharge?: number;

  // Images & Docs
  imageUrl?: string;
  imageUrls?: string[];
  certificatePdf?: string;

  // Status & Audits
  status?: 'Active' | 'Inactive' | 'Discontinued';
  lastPurchasePrice?: number;
  lastSellingPrice?: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const stoneDetailSchema = new Schema<IStoneDetail>({
  name: { type: String, required: true },
  pcs: { type: Number, default: 1 },
  weight: { type: Number, default: 0 },
  rate: { type: Number, default: 0 },
  amount: { type: Number, default: 0 },
}, { _id: false });

const diamondDetailSchema = new Schema<IDiamondDetail>({
  shape: { type: String, default: 'Round' },
  color: { type: String, default: 'G' },
  clarity: { type: String, default: 'VS1' },
  weight: { type: Number, default: 0 },
  pcs: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  certNo: { type: String },
  amount: { type: Number, default: 0 },
}, { _id: false });

const inventorySchema = new Schema<IInventory>(
  {
    name: { type: String, required: true },
    itemCode: { type: String },
    barcode: { type: String },
    qrCode: { type: String },
    sku: { type: String },
    category: { type: String, required: true, default: 'Gold' },
    subcategory: { type: String },
    brand: { type: String },
    collectionName: { type: String },
    productType: { type: String },
    designNo: { type: String },
    modelNo: { type: String },
    note: { type: String },

    metalType: { type: String, default: 'Gold' },
    purity: { type: String, default: '22K' },
    huid: { type: String },
    hallmarkCertified: { type: Boolean, default: true },
    metalColor: { type: String, default: 'Yellow' },
    gender: { type: String, default: 'Unisex' },

    grossWeight: { type: Number, required: true, default: 0 },
    stoneWeight: { type: Number, required: true, default: 0 },
    diamondWeight: { type: Number, default: 0 },
    otherWeight: { type: Number, default: 0 },
    netWeight: { type: Number, required: true, default: 0 },

    stones: [stoneDetailSchema],
    diamonds: [diamondDetailSchema],

    purchaseRate: { type: Number, default: 0 },
    metalRate: { type: Number, default: 0 },
    makingChargeType: { type: String, enum: ['per_gram', 'percentage', 'fixed'], default: 'fixed' },
    makingCharge: { type: Number, required: true, default: 500 },
    makingChargePct: { type: Number, default: 0 },
    wastagePct: { type: Number, default: 0 },
    stoneCost: { type: Number, default: 0 },
    diamondCost: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    costPrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    minSellingPrice: { type: Number, default: 0 },
    mrp: { type: Number, default: 0 },
    ratePerGram: { type: Number, default: 7200 },

    hsnCode: { type: String, default: '7113' },
    gstPct: { type: Number, required: true, default: 3 },
    gstType: { type: String, enum: ['Inclusive', 'Exclusive'], default: 'Exclusive' },

    stock: { type: Number, required: true, default: 1 },
    availableStock: { type: Number, default: 1 },
    reservedStock: { type: Number, default: 0 },
    minStock: { type: Number, default: 0 },
    maxStock: { type: Number, default: 100 },
    reorderLevel: { type: Number, default: 1 },
    allowNegativeStock: { type: Boolean, default: false },

    branch: { type: String, default: 'Main Store' },
    godown: { type: String, default: 'Main Vault' },
    rack: { type: String },
    shelf: { type: String },
    tray: { type: String },
    locker: { type: String },

    defaultSupplierId: { type: String },
    supplierItemCode: { type: String },
    leadTimeDays: { type: Number, default: 7 },

    isManufactured: { type: Boolean, default: false },
    bom: { type: String },
    labourCharge: { type: Number, default: 0 },
    castingCharge: { type: Number, default: 0 },
    polishingCharge: { type: Number, default: 0 },
    settingCharge: { type: Number, default: 0 },

    imageUrl: { type: String },
    imageUrls: [{ type: String }],
    certificatePdf: { type: String },

    status: { type: String, enum: ['Active', 'Inactive', 'Discontinued'], default: 'Active' },
    lastPurchasePrice: { type: Number, default: 0 },
    lastSellingPrice: { type: Number, default: 0 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export function getInventoryModel(conn: Connection): Model<IInventory> {
  return (
    (conn.models.Inventory as Model<IInventory>) ||
    conn.model<IInventory>('Inventory', inventorySchema)
  );
}
