import { table, text, integer } from 'durable-db/schema';

export const users = table('users', {
  id: text().primaryKey(),
  name: text().notNull(),
  nickname: text().notNull().default(''),
  email: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

export const posts = table('posts', {
  id: text().primaryKey(),
  title: text().notNull(),
  content: text(),
  authorId: text().notNull().references(() => users.id),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});
