ALTER TYPE "public"."ingest_issue_kind" ADD VALUE 'empty_guid' BEFORE 'duplicate_code';--> statement-breakpoint
ALTER TABLE "variant" ADD COLUMN "guid" text NOT NULL;--> statement-breakpoint
CREATE INDEX "variant_guid_idx" ON "variant" USING btree ("guid");