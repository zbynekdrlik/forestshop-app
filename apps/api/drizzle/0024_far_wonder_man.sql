CREATE TYPE "public"."mail_template_action" AS ENUM('save', 'reset');--> statement-breakpoint
CREATE TABLE "mail_template_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"action" "mail_template_action" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"changed_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "mail_template" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "mail_template_history" ADD CONSTRAINT "mail_template_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_template" ADD CONSTRAINT "mail_template_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_template_history_key_idx" ON "mail_template_history" USING btree ("key","changed_at");