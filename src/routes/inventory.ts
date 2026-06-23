import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Inventory, {
  resourceName: 'Inventory item',
});
