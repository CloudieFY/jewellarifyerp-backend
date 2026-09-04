import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/gold-rates.ts`
 * (was `buildTenantCrudRouter(models.GoldRates, { sortField: 'createdAt',
 *  readRoles: ['owner','operator','karigar'] })`).
 *
 * Everyone in the shop can read today's rate; only owner/operator can write.
 */
export default buildPgCrudRouter('gold_rates', {
  resourceName: 'Gold rate',
  idType: 'uuid',
  sortBy: 'created_at DESC',
  readRoles: ['owner', 'operator', 'karigar'],
});
