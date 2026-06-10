import { sql } from 'kysely';
import { action } from '../events';

export const getEventCounts = action({
  args: {},
  handler: async (db, _args, _ctx) => {
    const rows = await db
      .selectFrom('events')
      .select([
        'type',
        sql<number>`count(*)`.as('count'),
      ])
      .groupBy('type')
      .orderBy('count', 'desc')
      .execute();

    return rows;
  },
});
