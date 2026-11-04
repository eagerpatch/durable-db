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
//   import { createDbCommand } from 'durable-db/cli';
//   program.addCommand(createDbCommand());
//
// Or register them flat on any command (e.g. `mycli push` — the
// standalone `db` binary does this):
//
//   import { registerDbCommands } from 'durable-db/cli';
//   registerDbCommands(program);
//
// Or use the programmatic API directly:
//
//   import { push, status } from 'durable-db/cli';
//   const results = await push({ projectRoot: process.cwd() });
//

// Composable Commander commands
export { createDbCommand, registerDbCommands } from './command';
export type { DbCommandDefaults } from './command';
export type { DatabaseSource } from '../vite/modules/discovery';

// State management
export {
  type DevState,
  type DatabaseDevState,
  type DevPaths,
  type DevServerLock,
  loadDevState,
  saveDevState,
  getDevPaths,
  getDevEpoch,
  getDatabaseEpoch,
  getDatabaseEpochs,
  getInstanceKey,
  loadDevMigrations,
  generateEpoch,
  runningDevServer,
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
  UnsafeMigrationError,
} from './generate';

// Reset command
export {
  type ResetContext,
  type ResetOptions,
  type ResetResult,
  reset,
  resetAndPush,
  DevServerRunningError,
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
  type DatabaseDiff,
  type RenameResolutionOptions,
  discoverDatabases,
  selectDatabases,
  loadSchema,
  diffSchema,
  diffDatabases,
  reportCliError,
  UnknownDatabaseError,
} from './shared';

// Rename questions and migration risks
export {
  type MigrationRisk,
  type RenameAnswer,
  type SchemaAmbiguity,
  parseRenameSpec,
  SchemaRenameRequiredError,
} from '../migrations/snapshot';
