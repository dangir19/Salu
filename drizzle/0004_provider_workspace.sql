CREATE TABLE `provider_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`practice_id` text NOT NULL,
	`practice_name` text NOT NULL,
	`status` text NOT NULL,
	`service_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `provider_accounts_email_idx` ON `provider_accounts` (`email`);
CREATE INDEX `provider_accounts_practice_id_idx` ON `provider_accounts` (`practice_id`);

CREATE TABLE `appointment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`member_id` text NOT NULL,
	`member_display_name` text NOT NULL,
	`service_id` text NOT NULL,
	`service_name` text NOT NULL,
	`practice_id` text NOT NULL,
	`practice_name` text NOT NULL,
	`date` text NOT NULL,
	`mode` text NOT NULL,
	`credits_charged` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`assigned_provider_id` text,
	`proposed_date` text,
	`note` text,
	`walkthrough` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `appointment_requests_booking_id_idx` ON `appointment_requests` (`booking_id`);
CREATE INDEX `appointment_requests_practice_id_idx` ON `appointment_requests` (`practice_id`);
CREATE INDEX `appointment_requests_status_idx` ON `appointment_requests` (`status`);

CREATE TABLE `provider_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`practice_id` text NOT NULL,
	`status` text NOT NULL,
	`proposed_date` text,
	`created_at` text NOT NULL
);

CREATE INDEX `provider_assignments_provider_id_idx` ON `provider_assignments` (`provider_id`);

CREATE TABLE `provider_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`practice_id` text NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);

CREATE INDEX `provider_blocks_provider_id_idx` ON `provider_blocks` (`provider_id`);
