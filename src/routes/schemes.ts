import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Scheme, {
  resourceName: 'Scheme',
});
