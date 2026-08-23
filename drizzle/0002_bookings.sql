CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`service_id` text NOT NULL,
	`service_name` text NOT NULL,
	`provider` text NOT NULL,
	`availability_id` text,
	`date` text NOT NULL,
	`starts_at` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`credits_charged` integer DEFAULT 0 NOT NULL,
	`package_name` text,
	`package_item` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX `bookings_member_id_idx` ON `bookings` (`member_id`);
