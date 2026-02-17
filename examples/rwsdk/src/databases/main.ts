import { defineDatabase } from '@eagerpatch/durable-db/db';
import { products } from './schema';

export const { action } = defineDatabase({
  schema: { products },
});
