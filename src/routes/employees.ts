import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Employee, {
  resourceName: 'Employee',
  // writeRoles left at crudFactory's default (owner + operator) so both
  // GST and Non-GST logins can manage employees.
});
