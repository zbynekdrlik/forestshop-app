CREATE TABLE "pairing_variant_link" (
	"code" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing_decision" DROP CONSTRAINT "pairing_decision_url_ck";--> statement-breakpoint
ALTER TABLE "pairing_variant_link" ADD CONSTRAINT "pairing_variant_link_code_variant_code_fk" FOREIGN KEY ("code") REFERENCES "public"."variant"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_decision" ADD CONSTRAINT "pairing_decision_url_ck" CHECK (("pairing_decision"."status"::text IN ('good','manual') AND "pairing_decision"."url" IS NOT NULL) OR ("pairing_decision"."status"::text IN ('unavailable','discontinued','split') AND "pairing_decision"."url" IS NULL));