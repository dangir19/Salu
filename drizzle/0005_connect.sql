CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`member_id` text,
	`status` text DEFAULT 'approved' NOT NULL,
	`commission_rate` integer DEFAULT 20 NOT NULL,
	`stripe_connect_account_id` text,
	`connect_status` text DEFAULT 'not_connected' NOT NULL,
	`charges_enabled` integer DEFAULT 0 NOT NULL,
	`payouts_enabled` integer DEFAULT 0 NOT NULL,
	`details_submitted` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `providers_email_idx` ON `providers` (`email`);
CREATE UNIQUE INDEX `providers_member_id_idx` ON `providers` (`member_id`);
CREATE UNIQUE INDEX `providers_stripe_connect_account_id_idx` ON `providers` (`stripe_connect_account_id`);

CREATE TABLE `provider_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`gross_amount` integer NOT NULL,
	`commission_amount` integer NOT NULL,
	`net_payout` integer NOT NULL,
	`status` text NOT NULL,
	`stripe_transfer_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `provider_payouts_booking_id_idx` ON `provider_payouts` (`booking_id`);
CREATE INDEX `provider_payouts_provider_id_idx` ON `provider_payouts` (`provider_id`);
