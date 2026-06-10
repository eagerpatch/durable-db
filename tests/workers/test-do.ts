import { SqliteDurableObject, type Migrations } from '../../src/db/SqliteDurableObject';

/**
 * Minimal SqliteDurableObject subclass that deliberately contains a broken
 * migration. Used by the smoke-test suite to verify that migration failure
 * paths (log format, error propagation, diagnostic accessors) work against
 * a real workerd runtime — not just our mocks.
 */
export class TestMigrationDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_ok': {
      chunks: [['CREATE TABLE test_ok (id TEXT PRIMARY KEY)']],
    },
    '20240201_bad': {
      chunks: [
        [
          'CREATE TABLE test_bad_pre (id TEXT PRIMARY KEY)',
          'THIS IS NOT VALID SQL',
        ],
      ],
    },
  };
}

/** A DO with only successful migrations — used for the happy-path smoke. */
export class TestHappyDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_ok': {
      chunks: [['CREATE TABLE happy (id TEXT PRIMARY KEY)']],
    },
  };
}
