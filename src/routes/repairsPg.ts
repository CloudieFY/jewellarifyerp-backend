import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/repairs.ts`
 * (was `buildTenantCrudRouter(models.Repair,
 *  { writeRoles: ['owner','operator','karigar'] })`).
 */
export default buildPgCrudRouter('repairs', {
  resourceName: 'Repair',
  idType: 'uuid',
  writeRoles: ['owner', 'operator', 'karigar'],
});
