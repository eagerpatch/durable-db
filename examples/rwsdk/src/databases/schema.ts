import { table, text, integer } from '@eagerpatch/durable-db/schema';

// Products table (main DB)
export const products = table('products', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  priceInCents: integer().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

// Events table (events DB)
export const events = table('events', {
  id: text().primaryKey(),
  type: text().notNull(),
  payload: text(),
  sessionId: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});
