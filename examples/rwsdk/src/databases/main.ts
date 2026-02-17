import { defineDatabase } from '@shoplayer/database/db';
import { products } from './schema';

export const { action } = defineDatabase({
  schema: { products },
});
