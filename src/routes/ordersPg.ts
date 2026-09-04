import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/orders.ts`
 * (was `buildTenantCrudRouter(models.Order,
 *  { writeRoles: ['owner','operator','karigar'] })`).
 */
export default buildPgCrudRouter('orders', {
  resourceName: 'Order',
  idType: 'uuid',
  writeRoles: ['owner', 'operator', 'karigar'],
});
