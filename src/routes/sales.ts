import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Sales, {
  resourceName: 'Sale',
});
