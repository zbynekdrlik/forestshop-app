CREATE TYPE "public"."job_run_status" AS ENUM('running', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "job_run_status" DEFAULT 'running' NOT NULL,
	"detail" jsonb,
	"error_message" text
);
--> statement-breakpoint
CREATE INDEX "job_run_name_started_idx" ON "job_run" USING btree ("job_name","started_at");