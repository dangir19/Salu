CREATE TABLE `provider_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`business_name` text NOT NULL,
	`contact_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`services` text NOT NULL,
	`neighborhoods` text NOT NULL,
	`license_attested` integer DEFAULT 0 NOT NULL,
	`insurance_attested` integer DEFAULT 0 NOT NULL,
	`rate_expectation` text NOT NULL,
	`website` text,
	`notes` text,
	`status` text NOT NULL,
	`review_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX `provider_applications_status_idx` ON `provider_applications` (`status`);
CREATE INDEX `provider_applications_email_idx` ON `provider_applications` (`email`);
