/**
 * Central registration point for every CRM outbox handler. Called once from
 * the worker bootstrap (src/workerPg.ts). Idempotent.
 */

import { registerLeadOutboxHandlers } from './leadHandlers';
import { registerOpportunityOutboxHandlers } from './opportunityHandlers';
import { registerTaskOutboxHandlers } from './taskHandlers';

export function registerCrmOutboxHandlers(): void {
  registerLeadOutboxHandlers(); // Phase 1
  registerOpportunityOutboxHandlers(); // Phase 2
  registerTaskOutboxHandlers(); // Phase 2
}
