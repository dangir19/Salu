ALTER TABLE `members` ADD `stripe_customer_id` text;
ALTER TABLE `members` ADD `stripe_subscription_id` text;
ALTER TABLE `members` ADD `membership_status` text DEFAULT 'none';

CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`available_credits` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE `credit_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`kind` text NOT NULL,
	`credits` integer NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`booking_id` text,
	`stripe_event_id` text,
	`stripe_object_id` text
);

CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`processed_at` text NOT NULL
);
