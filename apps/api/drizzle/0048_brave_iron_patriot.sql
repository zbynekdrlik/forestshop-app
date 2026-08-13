CREATE TYPE "public"."pairing_decision_status" AS ENUM('good', 'manual', 'unavailable', 'discontinued');--> statement-breakpoint
CREATE TABLE "pairing_decision" (
	"product_key" text PRIMARY KEY NOT NULL,
	"status" "pairing_decision_status" NOT NULL,
	"url" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"state_synced_at" timestamp with time zone,
	CONSTRAINT "pairing_decision_url_ck" CHECK (("pairing_decision"."status" IN ('good','manual') AND "pairing_decision"."url" IS NOT NULL) OR ("pairing_decision"."status" IN ('unavailable','discontinued') AND "pairing_decision"."url" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "pairing_decision" ADD CONSTRAINT "pairing_decision_product_key_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."product"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_decision" ADD CONSTRAINT "pairing_decision_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;