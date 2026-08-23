import {primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  householdId: text("household_id"),
  planId: text("plan_id").notNull().default("member"),
  image: text("image"),
  authProvider: text("auth_provider"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memberAccounts = sqliteTable(
  "member_accounts",
  {
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    memberId: text("member_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({columns: [table.provider, table.providerAccountId]})],
);
