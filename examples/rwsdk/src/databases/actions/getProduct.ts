import { action } from '../main';

export const getProduct = action({
  args: {
    productId: 'string',
  },
  handler: async (db, args, _ctx) => {
    return db
      .selectFrom('products')
      .where('id', '=', args.productId)
      .selectAll()
      .executeTakeFirst();
  },
});
