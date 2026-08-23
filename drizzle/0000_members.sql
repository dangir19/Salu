CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`household_id` text,
	`plan_id` text DEFAULT 'member' NOT NULL,
	`image` text,
	`auth_provider` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `members_email_unique` ON `members` (`email`);

CREATE TABLE `member_accounts` (
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `provider_account_id`)
);
