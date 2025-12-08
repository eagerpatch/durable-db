import { defineDatabase } from '@shoplayer/database/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users, posts },
  // instance: 'per-shop' is the default
});

// Create a new user
export const createUser = action({
  args: {
    name: 'string',
    email: 'string.email',
  },
  handler: async (db, args, _ctx) => {
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

// Get a user by ID
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

// Get a user by email
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

// Create a user only if they don't exist (demonstrates internal DO call)
export const createUserIfNotExists = action({
  args: {
    name: 'string',
    email: 'string.email',
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

// Create a post
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

// Get user with posts - demonstrates multiple queries in one action
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

// List all users with pagination
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

// Example of cross-DO call (commented out - would need analytics DB)
// export const createUserWithAnalytics = action({
//   args: {
//     name: 'string',
//     email: 'string.email',
//   },
//   handler: async (db, args, ctx) => {
//     const user = await createUser({ name: args.name, email: args.email });
//     
//     // Cross-DO call to analytics database
//     const analyticsId = ctx.env.ANALYTICS_DATABASE_DO.idFromName('global');
//     const analytics = ctx.env.ANALYTICS_DATABASE_DO.get(analyticsId);
//     await analytics.logEvent({ type: 'user_created', userId: user.id });
//     
//     return user;
//   },
// });
