CREATE TYPE "public"."mail_log_source" AS ENUM('nedostupne', 'posta_uncollected', 'order_reminder', 'supplier_order');--> statement-breakpoint
CREATE TYPE "public"."mail_log_status" AS ENUM('sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."mail_log_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TABLE "mail_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"source" "mail_log_source" NOT NULL,
	"status" "mail_log_status" NOT NULL,
	"trigger" "mail_log_trigger" NOT NULL,
	"template_key" text,
	"recipient" text DEFAULT '' NOT NULL,
	"bcc" text,
	"subject" text,
	"order_code" text,
	"variant_code" text,
	"package_number" text,
	"sequence" integer,
	"reason" text,
	"actor_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_log_created_idx" ON "mail_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mail_log_source_created_idx" ON "mail_log" USING btree ("source","created_at");