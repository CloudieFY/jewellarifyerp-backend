import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Purchases, {
  resourceName: 'Purchase',
});
