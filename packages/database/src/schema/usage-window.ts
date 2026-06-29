import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { cliProviders } from './cli-providers.js';

/** Latest subscription usage-window snapshot per CLI provider, refreshed by the
 *  gentle usage poller (slice 3). One live row per provider (unique on
 *  provider_id); user_id is denormalized so the read API can scope by user
 *  without a join. All *_pct values are 0-100 percent CONSUMED; a null window
 *  means the vendor does not expose it. Disposable cache — safe to truncate;
 *  the poller repopulates on its next tick. */
export const usageWindowSnapshots = pgTable(
  'usage_window_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => cliProviders.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerName: varchar('provider_name', { length: 64 }).notNull(),
    fiveHourPct: integer('five_hour_pct'),
    fiveHourResetAt: timestamp('five_hour_reset_at'),
    sevenDayPct: integer('seven_day_pct'),
    sevenDayResetAt: timestamp('seven_day_reset_at'),
    dailyPct: integer('daily_pct'),
    dailyResetAt: timestamp('daily_reset_at'),
    /** 'ok' when the last fetch parsed; 'error' when the endpoint failed or the
     *  response shape didn't match (the chip hides for this provider). */
    status: varchar('status', { length: 16 }).notNull().default('ok'),
    errorMessage: text('error_message'),
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('usage_window_provider_idx').on(table.providerId),
    index('usage_window_user_idx').on(table.userId),
  ],
);
