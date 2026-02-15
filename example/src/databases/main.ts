import { defineDatabase } from '../../../src/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users, posts },
  browsable: true,
  // instance: 'per-shop' is the default
});
