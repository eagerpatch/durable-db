import { defineDatabase } from 'durable-db';
import { events } from './schema';

export const { action } = defineDatabase({
  schema: { events },
  transport: 'websocket',
});
