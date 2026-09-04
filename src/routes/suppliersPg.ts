import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/suppliers.ts` (which was just
 * `buildTenantCrudRouter(models.Supplier)`).
 *
 * The Mongo doc embedded a `transactions` array; here that is the child table
 * `supplier_transactions`. The frontend computes `outstanding` / `balanceGold`
 * / `balanceSilver` itself and sends them back on every save, so the server
 * just persists what it receives (same as the old crud factory did).
 *
 * `group` is a SQL reserved word, so it is stored in the `group_name` column
 * and mapped back to `group` on the way out.
 */
export default buildPgCrudRouter('suppliers', {
  resourceName: 'Supplier',
  sortBy: 'created_at DESC',
  idPrefix: 'supp',
  children: [
    {
      key: 'transactions',
      table: 'supplier_transactions',
      parentFk: 'supplier_id',
      orderBy: 'date ASC, id ASC',
      idPrefix: 'stx',
      withShopId: true,
    },
  ],
  beforeWrite: (body) => {
    if (body.group !== undefined && body.groupName === undefined) {
      body.groupName = body.group;
    }
    return body;
  },
  afterSerialize: (obj) => {
    if (obj.groupName !== undefined && obj.group === undefined) {
      obj.group = obj.groupName;
    }
    return obj;
  },
});
