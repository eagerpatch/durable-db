import { action } from '../main';

export const listProducts = action({
  args: {
    limit: 'number > 0',
    offset: 'number >= 0',
  },
  handler: async (db, args, _ctx) => {
    return db
      .selectFrom('products')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(args.limit)
      .offset(args.offset)
      .execute();
  },
});
