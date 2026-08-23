CREATE TABLE `member_credentials` (
	`email` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX `member_credentials_member_id_idx` ON `member_credentials` (`member_id`);
