import { action } from '../main';

export const listUsers = action({
  args: {
    limit: 'number > 0',
    offset: 'number >= 0',
  },
  handler: async (db, args, _ctx) => {
    return db
    .selectFrom('users')
    .selectAll()
    .limit(args.limit)
    .offset(args.offset)
    .execute();
  },
});
