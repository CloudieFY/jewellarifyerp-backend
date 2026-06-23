import { buildTenantCrudRouter } from './crudFactory';

export default buildTenantCrudRouter((models) => models.GoldRates, {
  resourceName: 'Gold rate',
  sortField: 'createdAt',
  readRoles: ['owner', 'operator', 'karigar'], // everyone in the shop can see today's rate
});
