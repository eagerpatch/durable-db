#!/usr/bin/env node
import { Command } from 'commander';
import {
  push,
  generate,
  reset,
  status,
  formatStatus,
  validate,
} from './index.js';

const program = new Command();

program
  .name('shoplayer-db')
  .description('Database migration management for Shoplayer')
  .version('0.0.1');

program
  .command('push')
  .description('Push schema changes to dev migrations')
  .option('-d, --databases-dir <dir>', 'Directory containing databases', 'src/databases')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const results = await push({
        databasesDir: options.databasesDir,
        verbose: options.verbose,
      });

      if (results.length === 0) {
        console.log('No databases found.');
        return;
      }

      let hasChanges = false;
      for (const r of results) {
        if (r.hasChanges) {
          hasChanges = true;
          console.log(`✓ ${r.database}: ${r.migrationName} (${r.statements.length} statements)`);
          if (r.wasReset) {
            console.log(`  ⚠ Dev state was reset due to production snapshot change`);
          }
        } else {
          console.log(`· ${r.database}: no changes`);
        }
      }

      if (!hasChanges) {
        console.log('\nAll databases are up to date.');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('generate [name]')
  .description('Generate production migration from schema changes')
  .option('--database <db>', 'Only generate for this database')
  .option('-d, --databases-dir <dir>', 'Directory containing databases', 'src/databases')
  .option('-v, --verbose', 'Verbose output')
  .action(async (name, options) => {
    try {
      const results = await generate(
        {
          databasesDir: options.databasesDir,
          verbose: options.verbose,
        },
        {
          name,
          database: options.database,
        }
      );

      if (results.length === 0) {
        console.log('No databases found.');
        return;
      }

      let hasChanges = false;
      for (const r of results) {
        if (r.hasChanges) {
          hasChanges = true;
          console.log(`✓ ${r.database}: ${r.migrationName}`);
          console.log(`  → ${r.migrationPath}`);
          console.log(`  ${r.statements.length} statement(s)`);
        } else {
          console.log(`· ${r.database}: no changes`);
        }
      }

      if (!hasChanges) {
        console.log('\nNo pending changes to generate.');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show database migration status')
  .option('-d, --databases-dir <dir>', 'Directory containing databases', 'src/databases')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const result = await status({
        databasesDir: options.databasesDir,
        verbose: options.verbose,
      });

      console.log(formatStatus(result));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('reset')
  .description('Reset dev state and create fresh DB instances')
  .option('--keep-epoch', 'Only clear dev migrations, keep the same epoch')
  .option('--database <db>', 'Only reset this database')
  .option('-d, --databases-dir <dir>', 'Directory containing databases', 'src/databases')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const result = await reset(
        {
          databasesDir: options.databasesDir,
          verbose: options.verbose,
        },
        {
          keepEpoch: options.keepEpoch,
          database: options.database,
        }
      );

      if (result.newEpoch) {
        console.log(`✓ New epoch: ${result.newEpoch}`);
      } else {
        console.log(`✓ Epoch unchanged`);
      }

      if (result.databases.length > 0) {
        console.log(`✓ Reset databases: ${result.databases.join(', ')}`);
      } else {
        console.log(`· No databases to reset`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Dry-run migrations against local SQLite to catch errors before deployment')
  .option('--database <db>', 'Only validate this database')
  .option('--no-dev', 'Skip dev migrations, only validate production')
  .option('-d, --databases-dir <dir>', 'Directory containing databases', 'src/databases')
  .option('-v, --verbose', 'Show each migration as it is applied')
  .action(async (options) => {
    try {
      const results = await validate({
        databasesDir: options.databasesDir,
        verbose: options.verbose,
        noDev: !options.dev,
        database: options.database,
      });

      if (results.length === 0) {
        console.log('No databases found.');
        return;
      }

      let allValid = true;
      for (const r of results) {
        const status = r.migrationsValid ? '✓' : '✗';
        const devNote = r.includesDevMigrations ? ' (includes dev migrations)' : '';
        console.log(`${status} ${r.database}: ${r.migrationCount} migration(s)${devNote}`);

        if (!r.migrationsValid) {
          allValid = false;
          for (const err of r.errors) {
            console.error(`  ✗ ${err.migration}[${err.chunk}]: ${err.error}`);
            if (options.verbose) {
              console.error(`    Statement: ${err.statement}`);
            }
          }
        }

        if (!r.schemaMatches) {
          allValid = false;
          console.warn(`  ⚠ Schema drift detected:`);
          for (const diff of r.schemaDiffs) {
            console.warn(`    ${diff}`);
          }
        } else if (r.migrationsValid) {
          console.log(`  Schema matches ✓`);
        }
      }

      if (!allValid) {
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
