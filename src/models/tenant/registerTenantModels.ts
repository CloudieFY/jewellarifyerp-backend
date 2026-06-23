import { Connection, Model } from 'mongoose';
import { getTenantUserModel, ITenantUser } from './User';
import { getCustomerModel, ICustomer } from './Customer';
import { getSupplierModel, ISupplier } from './Supplier';
import { getInventoryModel, IInventory } from './Inventory';
import { getSalesModel, ISales } from './Sales';
import { getPurchasesModel, IPurchases } from './Purchases';
import { getExpensesModel, IExpenses } from './Expenses';
import { getKarigarsModel, IKarigar } from './Karigars';
import { getJobworkModel, IJobwork } from './Jobwork';
import { getGoldRatesModel, IGoldRates } from './GoldRates';
import { getRepairModel, IRepair } from './Repair';
import { getInvoiceModel, IInvoice } from './Invoice';
import { getAdvanceModel, IAdvance } from './Advance';
import { getGirviModel, IGirvi } from './Girvi';
import { getOrderModel, IOrder } from './Order';
import { getEmployeeModel, IEmployee } from './Employee';
import { getSchemeModel, IScheme } from './Scheme';

/**
 * Bundle of all Models bound to ONE tenant's database connection.
 * Every route handler receives this bundle (via req.tenant.models) and
 * uses it exactly like the original single-tenant app used its global
 * models - except every query here is physically isolated to this shop's
 * own database.
 */
export interface TenantModels {
  User: Model<ITenantUser>;
  Customer: Model<ICustomer>;
  Supplier: Model<ISupplier>;
  Inventory: Model<IInventory>;
  Sales: Model<ISales>;
  Purchases: Model<IPurchases>;
  Expenses: Model<IExpenses>;
  Karigars: Model<IKarigar>;
  Jobwork: Model<IJobwork>;
  GoldRates: Model<IGoldRates>;
  Repair: Model<IRepair>;
  Invoice: Model<IInvoice>;
  Advance: Model<IAdvance>;
  Girvi: Model<IGirvi>;
  Order: Model<IOrder>;
  Employee: Model<IEmployee>;
  Scheme: Model<IScheme>;
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
    Jobwork: getJobworkModel(conn),
    GoldRates: getGoldRatesModel(conn),
    Repair: getRepairModel(conn),
    Invoice: getInvoiceModel(conn),
    Advance: getAdvanceModel(conn),
    Girvi: getGirviModel(conn),
    Order: getOrderModel(conn),
    Employee: getEmployeeModel(conn),
    Scheme: getSchemeModel(conn),
  };
}
