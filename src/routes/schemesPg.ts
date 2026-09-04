import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/schemes.ts`
 * (was `buildTenantCrudRouter(models.Scheme)`).
 */
export default buildPgCrudRouter('schemes', {
  resourceName: 'Scheme',
  idType: 'uuid',
});
