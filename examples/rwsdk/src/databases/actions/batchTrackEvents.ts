import { action } from '../events';

export const batchTrackEvents = action({
  args: {
    eventsJson: 'string',
  },
  handler: async (db, args, _ctx) => {
    const events = JSON.parse(args.eventsJson) as Array<{
      type: string;
      payload?: string;
      sessionId: string;
    }>;

    const rows = events.map((event) => ({
      id: crypto.randomUUID(),
      type: event.type,
      payload: event.payload ?? null,
      session_id: event.sessionId,
      created_at: new Date(),
    }));

    await db.insertInto('events').values(rows).execute();

    return { inserted: rows.length };
  },
});
