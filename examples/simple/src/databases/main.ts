import { defineDatabase } from 'durable-db';
import { users, posts } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users, posts },
  browsable: true,
});
