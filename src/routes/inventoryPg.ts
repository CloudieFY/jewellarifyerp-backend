import { buildPgCrudRouter } from '../db/crud';

/**
 * PostgreSQL port of `routes/inventory.ts`
 * (was `buildTenantCrudRouter(models.Inventory)`).
 *
 * `inventory.id` is a DB-generated uuid. The embedded `stones` / `diamonds`
 * arrays become the child tables `inventory_stones` / `inventory_diamonds`.
 * On delete we also clear this item's `stock_ledger` and `opening_stock`
 * rows, mirroring the special-case in `routes/crudFactory.ts`.
 */
export default buildPgCrudRouter('inventory', {
  resourceName: 'Inventory item',
  sortBy: 'created_at DESC',
  idType: 'uuid',
  children: [
    { key: 'stones', table: 'inventory_stones', parentFk: 'inventory_id', orderBy: 'id ASC' },
    { key: 'diamonds', table: 'inventory_diamonds', parentFk: 'inventory_id', orderBy: 'id ASC' },
  ],
  onDelete: async (client, id, row, shopId) => {
    const name = row?.name ?? null;
    await client.query(
      `DELETE FROM stock_ledger WHERE shop_id = $1 AND (item_id = $2 OR ($3::text IS NOT NULL AND item_name = $3))`,
      [shopId, id, name]
    );
    await client.query(
      `DELETE FROM opening_stock WHERE shop_id = $1 AND (item_id = $2 OR ($3::text IS NOT NULL AND item_name = $3))`,
      [shopId, id, name]
    );
  },
});
