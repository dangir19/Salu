import {integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  householdId: text("household_id"),
  planId: text("plan_id").notNull().default("member"),
  image: text("image"),
  authProvider: text("auth_provider"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  membershipStatus: text("membership_status").default("none"),
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

export const wallets = sqliteTable("wallets", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  memberId: text("member_id").notNull(),
  availableCredits: integer("available_credits").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const creditTransactions = sqliteTable("credit_transactions", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id").notNull(),
  kind: text("kind").notNull(),
  credits: integer("credits").notNull(),
  label: text("label").notNull(),
  createdAt: text("created_at").notNull(),
  bookingId: text("booking_id"),
  stripeEventId: text("stripe_event_id"),
  stripeObjectId: text("stripe_object_id"),
});

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: text("processed_at").notNull(),
});

export const providerApplications = sqliteTable("provider_applications", {
  id: text("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  licenseType: text("license_type").notNull(),
  licenseNumber: text("license_number").notNull(),
  mobileAtHome: integer("mobile_at_home").notNull().default(0),
  neighborhoods: text("neighborhoods").notNull(),
  rateAsk: text("rate_ask").notNull(),
  insuranceAttested: integer("insurance_attested").notNull().default(0),
  docsLicenseProof: text("docs_license_proof").notNull().default("missing"),
  docsInsurance: text("docs_insurance").notNull().default("missing"),
  notes: text("notes"),
  status: text("status").notNull(),
  reviewNote: text("review_note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const providerAccounts = sqliteTable("provider_accounts", {
  id: text("id").primaryKey(),
  memberId: text("member_id"),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  practiceId: text("practice_id").notNull(),
  practiceName: text("practice_name").notNull(),
  status: text("status").notNull(),
  serviceIds: text("service_ids").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const appointmentRequests = sqliteTable("appointment_requests", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  memberId: text("member_id").notNull(),
  memberDisplayName: text("member_display_name").notNull(),
  serviceId: text("service_id").notNull(),
  serviceName: text("service_name").notNull(),
  practiceId: text("practice_id").notNull(),
  practiceName: text("practice_name").notNull(),
  date: text("date").notNull(),
  mode: text("mode").notNull(),
  creditsCharged: integer("credits_charged").notNull().default(0),
  status: text("status").notNull(),
  assignedProviderId: text("assigned_provider_id"),
  proposedDate: text("proposed_date"),
  note: text("note"),
  walkthrough: integer("walkthrough").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const providerAssignments = sqliteTable("provider_assignments", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  bookingId: text("booking_id").notNull(),
  providerId: text("provider_id").notNull(),
  practiceId: text("practice_id").notNull(),
  status: text("status").notNull(),
  proposedDate: text("proposed_date"),
  createdAt: text("created_at").notNull(),
});

export const providerBlocks = sqliteTable("provider_blocks", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  practiceId: text("practice_id").notNull(),
  date: text("date").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull(),
  serviceId: text("service_id").notNull(),
  serviceName: text("service_name").notNull(),
  provider: text("provider").notNull(),
  availabilityId: text("availability_id"),
  date: text("date").notNull(),
  startsAt: text("starts_at"),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  creditsCharged: integer("credits_charged").notNull().default(0),
  packageName: text("package_name"),
  packageItem: text("package_item"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
