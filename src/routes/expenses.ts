import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.Expenses, {
  resourceName: 'Expense',
});
