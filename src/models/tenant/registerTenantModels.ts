import { Connection, Model } from 'mongoose';
import { getTenantUserModel, ITenantUser } from './User';
import { getCustomerModel, ICustomer } from './Customer';
import { getSupplierModel, ISupplier } from './Supplier';
import { getInventoryModel, IInventory } from './Inventory';
import { getSalesModel, ISales } from './Sales';
import { getPurchasesModel, IPurchases } from './Purchases';
import { getExpensesModel, IExpenses } from './Expenses';
import { getKarigarsModel, IKarigar } from './Karigars';
import { getGoldRatesModel, IGoldRates } from './GoldRates';
import { getRepairModel, IRepair } from './Repair';
import { getInvoiceModel, IInvoice } from './Invoice';
import { getSalesReturnModel, ISalesReturn } from './SalesReturn';
import { getAdvanceModel, IAdvance } from './Advance';
import { getGirviModel, IGirvi } from './Girvi';
import { getOrderModel, IOrder } from './Order';
import { getEmployeeModel, IEmployee } from './Employee';
import { getSchemeModel, IScheme } from './Scheme';
import { getCounterModel, ICounter } from './Counter';
import {
  getCategoryModel, ICategory,
  getSubCategoryModel, ISubCategory,
  getBrandModel, IBrand,
  getCollectionMasterModel, ICollectionMaster,
  getPurityMasterModel, IPurityMaster,
  getMetalMasterModel, IMetalMaster,
  getStoneMasterModel, IStoneMaster,
  getDiamondMasterModel, IDiamondMaster,
  getUnitMasterModel, IUnitMaster,
  getHsnMasterModel, IHsnMaster,
  getStockAdjustmentModel, IStockAdjustment,
  getStockTransferModel, IStockTransfer,
  getStockLedgerModel, IStockLedger,
  getOpeningStockModel, IOpeningStock
} from './InventoryMasters';

export interface TenantModels {
  User: Model<ITenantUser>;
  Customer: Model<ICustomer>;
  Supplier: Model<ISupplier>;
  Inventory: Model<IInventory>;
  Sales: Model<ISales>;
  Purchases: Model<IPurchases>;
  Expenses: Model<IExpenses>;
  Karigars: Model<IKarigar>;
  GoldRates: Model<IGoldRates>;
  Repair: Model<IRepair>;
  Invoice: Model<IInvoice>;
  SalesReturn: Model<ISalesReturn>;
  Counter: Model<ICounter>;
  Advance: Model<IAdvance>;
  Girvi: Model<IGirvi>;
  Order: Model<IOrder>;
  Employee: Model<IEmployee>;
  Scheme: Model<IScheme>;

  // Extended Inventory Masters & Stock Ledgers
  Category: Model<ICategory>;
  SubCategory: Model<ISubCategory>;
  Brand: Model<IBrand>;
  CollectionMaster: Model<ICollectionMaster>;
  PurityMaster: Model<IPurityMaster>;
  MetalMaster: Model<IMetalMaster>;
  StoneMaster: Model<IStoneMaster>;
  DiamondMaster: Model<IDiamondMaster>;
  UnitMaster: Model<IUnitMaster>;
  HsnMaster: Model<IHsnMaster>;
  StockAdjustment: Model<IStockAdjustment>;
  StockTransfer: Model<IStockTransfer>;
  StockLedger: Model<IStockLedger>;
  OpeningStock: Model<IOpeningStock>;
}

export function registerTenantModels(conn: Connection): TenantModels {
  return {
    User: getTenantUserModel(conn),
    Customer: getCustomerModel(conn),
    Supplier: getSupplierModel(conn),
    Inventory: getInventoryModel(conn),
    Sales: getSalesModel(conn),
    Purchases: getPurchasesModel(conn),
    Expenses: getExpensesModel(conn),
    Karigars: getKarigarsModel(conn),
    GoldRates: getGoldRatesModel(conn),
    Repair: getRepairModel(conn),
    Invoice: getInvoiceModel(conn),
    SalesReturn: getSalesReturnModel(conn),
    Counter: getCounterModel(conn),
    Advance: getAdvanceModel(conn),
    Girvi: getGirviModel(conn),
    Order: getOrderModel(conn),
    Employee: getEmployeeModel(conn),
    Scheme: getSchemeModel(conn),

    Category: getCategoryModel(conn),
    SubCategory: getSubCategoryModel(conn),
    Brand: getBrandModel(conn),
    CollectionMaster: getCollectionMasterModel(conn),
    PurityMaster: getPurityMasterModel(conn),
    MetalMaster: getMetalMasterModel(conn),
    StoneMaster: getStoneMasterModel(conn),
    DiamondMaster: getDiamondMasterModel(conn),
    UnitMaster: getUnitMasterModel(conn),
    HsnMaster: getHsnMasterModel(conn),
    StockAdjustment: getStockAdjustmentModel(conn),
    StockTransfer: getStockTransferModel(conn),
    StockLedger: getStockLedgerModel(conn),
    OpeningStock: getOpeningStockModel(conn),
  };
}
