import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Girvi, {
  resourceName: 'Girvi record',
});
