/**
 * ledger-fortress E2E Simulation wrapper.
 *
 * The maintained simulation lives with the TypeScript SDK so it can import the
 * SDK source and run under that package's dependencies. This wrapper preserves
 * the root-level command:
 *
 *   npx tsx test/e2e-simulation.ts
 */
import '../client/typescript/test/e2e-simulation.js';
