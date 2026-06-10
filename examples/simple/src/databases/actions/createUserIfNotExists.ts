// Create a user only if they don't exist (demonstrates internal DO call)
import { action } from '../main';
import { createUser } from './createUser';
import { getUserByEmail } from './getUserByEmail';

export const createUserIfNotExists = action({
  args: {
    name: 'string',
    email: 'string',
    lol: 'true',
  },
  handler: async (db, args, _ctx) => {
    // This calls getUserByEmail internally - will be transformed to this.getUserByEmail()
    const existing = await getUserByEmail({ email: args.email });
    if (existing) {
      return { created: false, user: existing };
    }

    // Create the new user
    const user = await createUser({ name: args.name, email: args.email });
    return { created: true, user };
  },
});
