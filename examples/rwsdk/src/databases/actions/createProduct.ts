import { action } from '../main';

export const createProduct = action({
  args: {
    name: 'string',
    description: 'string?',
    priceInCents: 'number > 0',
  },
  handler: async (db, args, _ctx) => {
    return db
      .insertInto('products')
      .values({
        id: crypto.randomUUID(),
        name: args.name,
        description: args.description ?? null,
        price_in_cents: args.priceInCents,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
});
