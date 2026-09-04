import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/girvi.ts`
 * (was `buildTenantCrudRouter(models.Girvi)`).
 *
 * The Mongo doc kept both a flat single-item shape (itemType, grossWeight, …)
 * AND an optional `items[]` array; the flat fields are plain columns on
 * `girvi` and the array is the child table `girvi_items`.
 *
 * The `interestAmount` / `forwardedInterestAmount` Mongoose virtuals are not
 * ported — the frontend computes interest client-side and never reads them.
 */
export default buildPgCrudRouter('girvi', {
  resourceName: 'Girvi record',
  idType: 'uuid',
  children: [
    { key: 'items', table: 'girvi_items', parentFk: 'girvi_id', orderBy: 'id ASC' },
  ],
});
