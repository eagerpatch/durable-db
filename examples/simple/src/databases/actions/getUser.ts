import { action } from '../main';

export const getUser = action({
  args: {
    userId: 'string',
  },
  handler: async (db, args, _ctx) => {
    return db
    .selectFrom('users')
    .where('id', '=', args.userId)
    .selectAll()
    .executeTakeFirst();
  },
});
