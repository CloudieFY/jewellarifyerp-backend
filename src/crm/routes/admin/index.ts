import { Router } from 'express';
import { requireSuperAdminPg } from '../../../middleware/authPg';
import metaRouter from './meta';
import leadsRouter from './leads';
import opportunitiesRouter from './opportunities';
import tasksRouter from './tasks';
import demosRouter from './demos';
import quotationsRouter from './quotations';

/**
 * Super Admin CRM API — mounted at `/api/superadmin/crm` by src/serverPg.ts.
 *
 * Every route here is gated by requireSuperAdminPg (a tenant JWT never
 * passes — 401/403). This is a SEPARATE mount from `/api/crm` (tenant CRM,
 * now permanently denied for all tenant users — see src/crm/permissions.ts)
 * and reuses the exact same engine: src/crm/{leads,opportunities,tasks}/
 * repository.ts, src/crm/leads/service.ts, audit/outbox/activity helpers.
 * See src/crm/routes/admin/_shared.ts for why actor_user_id is always null
 * on admin-originated audit/activity rows.
 *
 *   /api/superadmin/crm/shops              meta — shop picker
 *   /api/superadmin/crm/dashboard          meta — cross-shop rollup
 *   /api/superadmin/crm/leads/*            cross-shop list + per-shop CRUD/actions
 *   /api/superadmin/crm/opportunities/*    cross-shop list + per-shop CRUD/actions
 *   /api/superadmin/crm/tasks/*            cross-shop list + per-shop CRUD/actions
 *   /api/superadmin/crm/demos/*            cross-shop list + per-shop CRUD/actions (Slice 4)
 *   /api/superadmin/crm/quotations/*       per-opportunity CRUD/actions (Slice 4, foundation scope)
 */
const crmAdminRouter = Router();

crmAdminRouter.use(requireSuperAdminPg);

crmAdminRouter.use('/leads', leadsRouter);
crmAdminRouter.use('/opportunities', opportunitiesRouter);
crmAdminRouter.use('/tasks', tasksRouter);
crmAdminRouter.use('/demos', demosRouter);
crmAdminRouter.use('/quotations', quotationsRouter);
crmAdminRouter.use('/', metaRouter);

export default crmAdminRouter;
