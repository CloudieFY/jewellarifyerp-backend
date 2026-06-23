import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Employee, {
  resourceName: 'Employee',
  writeRoles: ['owner'], // payroll data - owner only
});
