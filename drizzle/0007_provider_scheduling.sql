CREATE TABLE `provider_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_minutes` integer NOT NULL,
	`end_minutes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX `provider_availability_provider_day_idx` ON `provider_availability` (`provider_id`, `day_of_week`);

CREATE TABLE `provider_date_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`date` text NOT NULL,
	`start_minutes` integer,
	`end_minutes` integer,
	`is_closed` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX `provider_date_overrides_provider_date_idx` ON `provider_date_overrides` (`provider_id`, `date`);

ALTER TABLE `bookings` ADD COLUMN `provider_id` text;
ALTER TABLE `bookings` ADD COLUMN `slot_end` text;
