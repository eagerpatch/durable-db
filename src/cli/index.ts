// ============================================================================
// CLI Module Exports
// ============================================================================
//
// This module provides composable functions for database management.
// It's designed to be consumed by higher-level CLI tools (like `shoplayer`)
// rather than used directly.
//
// Example usage in shoplayer CLI:
//
//   import { command } from 'commander';
//   import * as db from '@shoplayer/database/cli';
//
//   program
//     .command('db:push')
//     .description('Push schema changes to dev migrations')
//     .action(async () => {
//       const results = await db.push({ projectRoot: process.cwd() });
//       for (const r of results) {
//         if (r.hasChanges) {
//           console.log(`✓ ${r.database}: ${r.statements.length} statements`);
//         }
//       }
//     });
//

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
