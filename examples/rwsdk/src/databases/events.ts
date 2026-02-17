import { defineDatabase } from '@shoplayer/database/db';
import { events } from './schema';

export const { action } = defineDatabase({
  schema: { events },
  transport: 'websocket',
});
