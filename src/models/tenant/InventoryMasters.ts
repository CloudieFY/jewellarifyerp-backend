import { Schema, Connection, Model, Document } from 'mongoose';

// ----------------------------------------------------
// 1. Category Master
// ----------------------------------------------------
export interface ICategory extends Document {
  code: string;
  name: string;
  description?: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const categorySchema = new Schema<ICategory>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 2. SubCategory Master
// ----------------------------------------------------
export interface ISubCategory extends Document {
  categoryId: string;
  categoryName: string;
  code: string;
  name: string;
  description?: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const subCategorySchema = new Schema<ISubCategory>(
  {
    categoryId: { type: String, required: true },
    categoryName: { type: String, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 3. Brand Master
// ----------------------------------------------------
export interface IBrand extends Document {
  code: string;
  name: string;
  description?: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const brandSchema = new Schema<IBrand>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 4. Collection Master
// ----------------------------------------------------
export interface ICollectionMaster extends Document {
  code: string;
  name: string;
  description?: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const collectionSchema = new Schema<ICollectionMaster>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 5. Purity Master
// ----------------------------------------------------
export interface IPurityMaster extends Document {
  name: string; // e.g. 24K, 22K, 18K, 14K, 925, 999
  metalType: string; // Gold, Silver, Platinum
  purityPercentage: number; // e.g. 91.6, 75.0
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const puritySchema = new Schema<IPurityMaster>(
  {
    name: { type: String, required: true },
    metalType: { type: String, default: 'Gold' },
    purityPercentage: { type: Number, default: 91.6 },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 6. Metal Master
// ----------------------------------------------------
export interface IMetalMaster extends Document {
  name: string; // Gold, Silver, Diamond, Platinum, Gemstone
  code: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const metalSchema = new Schema<IMetalMaster>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 7. Stone Master
// ----------------------------------------------------
export interface IStoneMaster extends Document {
  name: string;
  type: string;
  color?: string;
  defaultRate: number;
  unit: string; // Carat, Pcs, Grams
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const stoneMasterSchema = new Schema<IStoneMaster>(
  {
    name: { type: String, required: true },
    type: { type: String, default: 'Precious' },
    color: { type: String },
    defaultRate: { type: Number, default: 0 },
    unit: { type: String, default: 'Carat' },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 8. Diamond Master
// ----------------------------------------------------
export interface IDiamondMaster extends Document {
  shape: string; // Round, Princess, Emerald, Oval, Pear, Marquise
  color: string; // D, E, F, G, H, I, J
  clarity: string; // IF, VVS1, VVS2, VS1, VS2, SI1, SI2
  defaultRatePerCarat: number;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const diamondMasterSchema = new Schema<IDiamondMaster>(
  {
    shape: { type: String, required: true },
    color: { type: String, default: 'G' },
    clarity: { type: String, default: 'VS1' },
    defaultRatePerCarat: { type: Number, default: 0 },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 9. Unit Master
// ----------------------------------------------------
export interface IUnitMaster extends Document {
  name: string; // Grams, Kilograms, Pieces, Carats
  symbol: string; // g, kg, pcs, ct
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const unitMasterSchema = new Schema<IUnitMaster>(
  {
    name: { type: String, required: true },
    symbol: { type: String, required: true },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 10. HSN Master
// ----------------------------------------------------
export interface IHsnMaster extends Document {
  hsnCode: string;
  gstPct: number;
  description?: string;
  status: 'Active' | 'Inactive';
  createdAt: Date;
  updatedAt: Date;
}
const hsnMasterSchema = new Schema<IHsnMaster>(
  {
    hsnCode: { type: String, required: true },
    gstPct: { type: Number, required: true, default: 3 },
    description: { type: String },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 11. Stock Adjustment
// ----------------------------------------------------
export interface IStockAdjustment extends Document {
  adjustmentNo: string;
  date: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  type: 'INCREASE' | 'DECREASE';
  qty: number;
  grossWeight: number;
  netWeight: number;
  reason: string;
  remarks?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
const stockAdjustmentSchema = new Schema<IStockAdjustment>(
  {
    adjustmentNo: { type: String, required: true },
    date: { type: String, required: true },
    itemId: { type: String, required: true },
    itemCode: { type: String, required: true },
    itemName: { type: String, required: true },
    type: { type: String, enum: ['INCREASE', 'DECREASE'], required: true },
    qty: { type: Number, required: true, default: 1 },
    grossWeight: { type: Number, default: 0 },
    netWeight: { type: Number, default: 0 },
    reason: { type: String, required: true },
    remarks: { type: String },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 12. Stock Transfer
// ----------------------------------------------------
export interface IStockTransfer extends Document {
  transferNo: string;
  date: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  fromBranch: string;
  toBranch: string;
  fromGodown?: string;
  toGodown?: string;
  qty: number;
  grossWeight: number;
  netWeight: number;
  status: 'Completed' | 'Pending' | 'Cancelled';
  remarks?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
const stockTransferSchema = new Schema<IStockTransfer>(
  {
    transferNo: { type: String, required: true },
    date: { type: String, required: true },
    itemId: { type: String, required: true },
    itemCode: { type: String, required: true },
    itemName: { type: String, required: true },
    fromBranch: { type: String, required: true },
    toBranch: { type: String, required: true },
    fromGodown: { type: String },
    toGodown: { type: String },
    qty: { type: Number, required: true, default: 1 },
    grossWeight: { type: Number, default: 0 },
    netWeight: { type: Number, default: 0 },
    status: { type: String, enum: ['Completed', 'Pending', 'Cancelled'], default: 'Completed' },
    remarks: { type: String },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 13. Stock Ledger
// ----------------------------------------------------
export interface IStockLedger extends Document {
  date: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  transactionType: 'OPENING' | 'PURCHASE' | 'SALE' | 'TRANSFER' | 'ADJUSTMENT' | 'REPAIR' | 'MANUFACTURING' | 'RETURN';
  qtyChange: number;
  grossWeightChange: number;
  netWeightChange: number;
  balanceQty: number;
  balanceGrossWeight: number;
  balanceNetWeight: number;
  referenceNo?: string;
  remarks?: string;
  createdAt: Date;
  updatedAt: Date;
}
const stockLedgerSchema = new Schema<IStockLedger>(
  {
    date: { type: String, required: true },
    itemId: { type: String, required: true },
    itemCode: { type: String, required: true },
    itemName: { type: String, required: true },
    transactionType: {
      type: String,
      enum: ['OPENING', 'PURCHASE', 'SALE', 'TRANSFER', 'ADJUSTMENT', 'REPAIR', 'MANUFACTURING', 'RETURN'],
      required: true,
    },
    qtyChange: { type: Number, required: true },
    grossWeightChange: { type: Number, default: 0 },
    netWeightChange: { type: Number, default: 0 },
    balanceQty: { type: Number, required: true },
    balanceGrossWeight: { type: Number, default: 0 },
    balanceNetWeight: { type: Number, default: 0 },
    referenceNo: { type: String },
    remarks: { type: String },
  },
  { timestamps: true }
);

// ----------------------------------------------------
// 14. Opening Stock Entry
// ----------------------------------------------------
export interface IOpeningStock extends Document {
  entryNo: string;
  date: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  qty: number;
  grossWeight: number;
  netWeight: number;
  rate: number;
  totalValue: number;
  remarks?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
const openingStockSchema = new Schema<IOpeningStock>(
  {
    entryNo: { type: String, required: true },
    date: { type: String, required: true },
    itemId: { type: String, required: true },
    itemCode: { type: String, required: true },
    itemName: { type: String, required: true },
    qty: { type: Number, required: true, default: 1 },
    grossWeight: { type: Number, default: 0 },
    netWeight: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    totalValue: { type: Number, default: 0 },
    remarks: { type: String },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// Model Getters
export function getCategoryModel(conn: Connection): Model<ICategory> {
  return conn.models.Category || conn.model<ICategory>('Category', categorySchema);
}

export function getSubCategoryModel(conn: Connection): Model<ISubCategory> {
  return conn.models.SubCategory || conn.model<ISubCategory>('SubCategory', subCategorySchema);
}

export function getBrandModel(conn: Connection): Model<IBrand> {
  return conn.models.Brand || conn.model<IBrand>('Brand', brandSchema);
}

export function getCollectionMasterModel(conn: Connection): Model<ICollectionMaster> {
  return conn.models.CollectionMaster || conn.model<ICollectionMaster>('CollectionMaster', collectionSchema);
}

export function getPurityMasterModel(conn: Connection): Model<IPurityMaster> {
  return conn.models.PurityMaster || conn.model<IPurityMaster>('PurityMaster', puritySchema);
}

export function getMetalMasterModel(conn: Connection): Model<IMetalMaster> {
  return conn.models.MetalMaster || conn.model<IMetalMaster>('MetalMaster', metalSchema);
}

export function getStoneMasterModel(conn: Connection): Model<IStoneMaster> {
  return conn.models.StoneMaster || conn.model<IStoneMaster>('StoneMaster', stoneMasterSchema);
}

export function getDiamondMasterModel(conn: Connection): Model<IDiamondMaster> {
  return conn.models.DiamondMaster || conn.model<IDiamondMaster>('DiamondMaster', diamondMasterSchema);
}

export function getUnitMasterModel(conn: Connection): Model<IUnitMaster> {
  return conn.models.UnitMaster || conn.model<IUnitMaster>('UnitMaster', unitMasterSchema);
}

export function getHsnMasterModel(conn: Connection): Model<IHsnMaster> {
  return conn.models.HsnMaster || conn.model<IHsnMaster>('HsnMaster', hsnMasterSchema);
}

export function getStockAdjustmentModel(conn: Connection): Model<IStockAdjustment> {
  return conn.models.StockAdjustment || conn.model<IStockAdjustment>('StockAdjustment', stockAdjustmentSchema);
}

export function getStockTransferModel(conn: Connection): Model<IStockTransfer> {
  return conn.models.StockTransfer || conn.model<IStockTransfer>('StockTransfer', stockTransferSchema);
}

export function getStockLedgerModel(conn: Connection): Model<IStockLedger> {
  return conn.models.StockLedger || conn.model<IStockLedger>('StockLedger', stockLedgerSchema);
}

export function getOpeningStockModel(conn: Connection): Model<IOpeningStock> {
  return conn.models.OpeningStock || conn.model<IOpeningStock>('OpeningStock', openingStockSchema);
}
