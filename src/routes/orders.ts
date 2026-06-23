import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Order, {
  resourceName: 'Order',
});
