import { defineDatabase } from '@shoplayer/database/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users, posts },
  browsable: true,
  // instance: 'per-tenant' is the default
});
