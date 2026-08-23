CREATE TABLE `provider_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`license_type` text NOT NULL,
	`license_number` text NOT NULL,
	`mobile_at_home` integer DEFAULT 0 NOT NULL,
	`neighborhoods` text NOT NULL,
	`rate_ask` text NOT NULL,
	`insurance_attested` integer DEFAULT 0 NOT NULL,
	`docs_license_proof` text DEFAULT 'missing' NOT NULL,
	`docs_insurance` text DEFAULT 'missing' NOT NULL,
	`notes` text,
	`status` text NOT NULL,
	`review_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX `provider_applications_status_idx` ON `provider_applications` (`status`);
CREATE INDEX `provider_applications_email_idx` ON `provider_applications` (`email`);
CREATE INDEX `provider_applications_license_type_idx` ON `provider_applications` (`license_type`);
