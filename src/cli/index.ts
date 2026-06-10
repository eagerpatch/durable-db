// ============================================================================
// CLI Module Exports
// ============================================================================
//
// This module provides both composable Commander commands and
// programmatic functions for database management.
//
// Mount the commands under a `db` group in your own Commander program
// (e.g. `mycli db push`):
//
//   import { createDbCommand } from '@eagerpatch/durable-db/cli';
//   program.addCommand(createDbCommand());
//
// Or register them flat on any command (e.g. `mycli push` — the
// standalone `db` binary does this):
//
//   import { registerDbCommands } from '@eagerpatch/durable-db/cli';
//   registerDbCommands(program);
//
// Or use the programmatic API directly:
//
//   import { push, status } from '@eagerpatch/durable-db/cli';
//   const results = await push({ projectRoot: process.cwd() });
//

// Composable Commander commands
export { createDbCommand, registerDbCommands } from './command';

// State management
export {
  type DevState,
  type DatabaseDevState,
  type DevPaths,
  loadDevState,
  saveDevState,
  getDevPaths,
  getDevEpoch,
  getInstanceKey,
  loadDevMigrations,
  generateEpoch,
} from './state';

// Push command
export {
  type PushContext,
  type PushResult,
  push,
  pushOne,
} from './push';

// Generate command
export {
  type GenerateContext,
  type GenerateOptions,
  type GenerateResult,
  generate,
  generateOne,
} from './generate';

// Reset command
export {
  type ResetContext,
  type ResetOptions,
  type ResetResult,
  reset,
  resetAndPush,
} from './reset';

// Status command
export {
  type StatusContext,
  type DatabaseStatus,
  type StatusResult,
  status,
  formatStatus,
} from './status';

// Validate command
export {
  type ValidateContext,
  type ValidateError,
  type ValidateResult,
  validate,
} from './validate';

// Shared helpers
export {
  type DiscoverOptions,
  type DiffResult,
  discoverDatabases,
  loadSchema,
  diffSchema,
  reportCliError,
} from './shared';
