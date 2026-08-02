CREATE TYPE "public"."nedostupne_email_type" AS ENUM('nedostupne', 'alternativa');--> statement-breakpoint
CREATE TABLE "nedostupne_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_code" text NOT NULL,
	"variant_code" text NOT NULL,
	"email_type" "nedostupne_email_type" NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "related_codes" text[];--> statement-breakpoint
CREATE UNIQUE INDEX "nedostupne_state_order_variant_type_uq" ON "nedostupne_state" USING btree ("order_code","variant_code","email_type");