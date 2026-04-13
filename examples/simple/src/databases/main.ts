import { defineDatabase } from '@eagerpatch/durable-db/db';
import { users, posts } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users, posts },
  browsable: true,
});
