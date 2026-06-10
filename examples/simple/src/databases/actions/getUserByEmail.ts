import { action } from '../main';

export const getUserByEmail = action({
  args: {
    email: 'string.email',
  },
  handler: async (db, args, _ctx) => {
    return db
    .selectFrom('users')
    .where('email', '=', args.email)
    .selectAll()
    .executeTakeFirst();
  },
});
