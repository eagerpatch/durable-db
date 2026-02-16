import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Products table (main DB)
export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  priceInCents: integer('price_in_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// Events table (events DB)
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: text('payload'),
  sessionId: text('session_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
