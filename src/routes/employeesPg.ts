import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/employees.ts`
 * (was `buildTenantCrudRouter(models.Employee)`).
 *
 * `employees.id` is `text` (the Mongo `_id` hex string was preserved on
 * migration), so new rows get a generated id here. `payments` is a jsonb
 * column — the CRUD layer JSON-encodes it automatically.
 */
export default buildPgCrudRouter('employees', {
  resourceName: 'Employee',
  idType: 'text',
});
