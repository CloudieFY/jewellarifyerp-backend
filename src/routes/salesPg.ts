import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/sales.ts`
 * (was `buildTenantCrudRouter(models.Sales)`).
 *
 * `sale.items` (embedded array in Mongo) is the child table `sale_items`.
 */
export default buildPgCrudRouter('sales', {
  resourceName: 'Sale',
  idType: 'uuid',
  children: [
    { key: 'items', table: 'sale_items', parentFk: 'sale_id', orderBy: 'id ASC' },
  ],
});
