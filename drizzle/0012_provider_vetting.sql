-- Provider vetting: resume/portfolio links, background-check consent capture, and
-- background-check status tracking on provider applications.
-- Consent is collected at apply time and is required for every applicant who
-- would visit members at home. No background-check vendor API is integrated
-- here; staff update bg_check_status manually as checks clear.
-- NOTE: D1 migrations are applied manually in production (same as 0007–0011);
-- db/providers.ts ensureProviderApplicationsSchema() also backfills these
-- columns at runtime.
ALTER TABLE provider_applications ADD COLUMN resume_url text;
ALTER TABLE provider_applications ADD COLUMN bg_check_consent integer NOT NULL DEFAULT 0;
ALTER TABLE provider_applications ADD COLUMN bg_check_status text NOT NULL DEFAULT 'pending';
