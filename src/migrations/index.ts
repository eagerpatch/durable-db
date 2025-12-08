// Snapshot utilities
export {
  type Snapshot,
  createEmptySnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  generateSnapshotId,
  snapshotsEqual,
  hashSnapshot,
} from './snapshot.js';

// Migration generation
export {
  type MigrationResult,
  type GenerateMigrationOptions,
  type MigrationData,
  generateMigration,
  generateMigrationName,
  loadSnapshot,
  saveSnapshot,
  loadMigrationFiles,
  loadSchemaModule,
  buildAndLoadSchema,
  generateCreateTableSQL,
  parseSqlMigration,
} from './generator.js';
