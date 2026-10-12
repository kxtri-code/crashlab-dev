/**
 * CrashLab Hosted MVP Product Foundation — Build 11.
 *
 * Core module exports for product domain contracts, tenant isolation,
 * repositories, lifecycle state machine, and minimal product API.
 */

export * from './types/index.js';
export * from './auth/roles.js';
export * from './auth/permissions.js';
export * from './lifecycle/runStateMachine.js';
export * from './secrets/secretProvider.js';
export * from './secrets/sanitizer.js';
export * from './repository/interfaces.js';
export * from './repository/inMemory.js';
export * from './service/preflightAdapter.js';
export * from './service/productService.js';
export * from './service/rehearsal.js';
export * from './api/types.js';
export * from './api/routes.js';
export * from './api/server.js';
export * from './util/id.js';
