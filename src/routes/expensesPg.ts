import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/expenses.ts`
 * (was `buildTenantCrudRouter(models.Expenses)`).
 */
export default buildPgCrudRouter('expenses', {
  resourceName: 'Expense',
  idType: 'uuid',
});
