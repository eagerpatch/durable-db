import { defineDatabase } from 'durable-db';
import { products } from './schema';

export const { action } = defineDatabase({
  schema: { products },
});
