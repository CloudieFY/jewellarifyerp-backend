import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Jobwork, {
  resourceName: 'Jobwork',
});
