// Create a new user
import { action } from '../main';
import { getUserByEmail } from './getUserByEmail';

export const createUser = action({
  args: {
    name: 'string',
    email: 'string.email',
  },
  handler: async (db, args, _ctx) => {
    const hasUser = await getUserByEmail({ email: args.email });

    if (hasUser?.id) {
      throw new Error('User with this email already exists');
    }

    return db
    .insertInto('users')
    .values({
      id: crypto.randomUUID(),
      name: args.name,
      email: args.email,
      created_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  },
});
