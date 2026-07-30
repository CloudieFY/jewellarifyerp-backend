import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Supplier, {
  resourceName: 'Supplier',
});
