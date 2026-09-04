import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/advances.ts`
 * (was `buildTenantCrudRouter(models.Advance)`).
 */
export default buildPgCrudRouter('advances', {
  resourceName: 'Advance',
  idType: 'uuid',
});
