import { defineDatabase } from '@eagerpatch/durable-db/db';
import { events } from './schema';

export const { action } = defineDatabase({
  schema: { events },
  transport: 'websocket',
});
