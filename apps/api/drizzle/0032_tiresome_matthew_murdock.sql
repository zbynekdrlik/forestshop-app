CREATE TABLE "nedostupne_replacement_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_code" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nedostupne_replacement_link_variant_idx" ON "nedostupne_replacement_link" USING btree ("variant_code");