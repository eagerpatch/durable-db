import { action } from '../main';

export const getUserWithPosts = action({
  args: {
    userId: 'string',
  },
  handler: async (db, args, _ctx) => {
    const user = await db
    .selectFrom('users')
    .where('id', '=', args.userId)
    .selectAll()
    .executeTakeFirst();

    if (!user) {
      return null;
    }

    const userPosts = await db
    .selectFrom('posts')
    .where('author_id', '=', args.userId)
    .selectAll()
    .execute();

    return { user, posts: userPosts };
  },
});
