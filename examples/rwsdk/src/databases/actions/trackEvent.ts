import { action } from '../events';

export const trackEvent = action({
  args: {
    type: 'string',
    payload: 'string?',
    sessionId: 'string',
  },
  handler: async (db, args, _ctx) => {
    return db
      .insertInto('events')
      .values({
        id: crypto.randomUUID(),
        type: args.type,
        payload: args.payload ?? null,
        session_id: args.sessionId,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
});
