import { defineDatabase } from '../../../src/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users, posts },
  // instance: 'per-shop' is the default
});
