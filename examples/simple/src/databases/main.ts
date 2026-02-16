import { defineDatabase } from '@shoplayer/database/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  schema: { users, posts },
  browsable: true,
});
