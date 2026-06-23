import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Repair, {
  resourceName: 'Repair',
});
