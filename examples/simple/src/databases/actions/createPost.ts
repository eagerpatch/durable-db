import { action } from '../main';

export const createPost = action({
  args: {
    title: 'string',
    content: 'string?',
    authorId: 'string',
  },
  handler: async (db, args, _ctx) => {
    return db
    .insertInto('posts')
    .values({
      id: crypto.randomUUID(),
      title: args.title,
      content: args.content ?? null,
      author_id: args.authorId,
      created_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  },
});
