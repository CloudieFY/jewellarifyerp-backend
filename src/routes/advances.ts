import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Advance, {
  resourceName: 'Advance',
});
