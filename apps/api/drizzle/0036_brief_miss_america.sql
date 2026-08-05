CREATE TYPE "public"."upozornenie_source" AS ENUM('vlastne', 'appka');--> statement-breakpoint
CREATE TYPE "public"."upozornenie_type" AS ENUM('vlastna_poznamka');--> statement-breakpoint
CREATE TABLE "upozornenie" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "upozornenie_type" NOT NULL,
	"source" "upozornenie_source" NOT NULL,
	"title" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"link" text,
	"dedup_key" text,
	"due_at" timestamp with time zone,
	"postponed_until" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upozornenie" ADD CONSTRAINT "upozornenie_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upozornenie" ADD CONSTRAINT "upozornenie_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upozornenie_dedup_key_uq" ON "upozornenie" USING btree ("dedup_key") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "upozornenie_resolved_at_idx" ON "upozornenie" USING btree ("resolved_at");