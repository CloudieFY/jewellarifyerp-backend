import { Router } from 'express';
import metaRouter from './meta';
import leadsRouter from './leads';
import customersRouter from './customers';
import opportunitiesRouter from './opportunities';
import tasksRouter from './tasks';

/**
 * CRM API router — mounted at `/api/crm` by src/serverPg.ts.
 *
 *   /api/crm/health, /api/crm/me           meta
 *   /api/crm/leads/*                        Phase 1 — lead management
 *   /api/crm/customers/*                    Phase 1 — CRM view over ERP customers
 *   /api/crm/opportunities/*                Phase 2 — sales pipeline
 *   /api/crm/tasks/*                        Phase 2 — assignable to-dos
 *
 * Every business sub-router guards itself with `requireCrmPermission(...)` and
 * runs inside `withTenant()` so PostgreSQL RLS is the enforced isolation
 * boundary. Later phases (quotations, tickets, ...) mount here the same way.
 */
const crmRouter = Router();

crmRouter.use('/leads', leadsRouter);
crmRouter.use('/customers', customersRouter);
crmRouter.use('/opportunities', opportunitiesRouter);
crmRouter.use('/tasks', tasksRouter);
crmRouter.use('/', metaRouter);

export default crmRouter;
