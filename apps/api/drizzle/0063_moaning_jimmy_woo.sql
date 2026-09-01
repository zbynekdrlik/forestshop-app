CREATE TABLE "nedostupne_resolved" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_code" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "nedostupne_resolved_variant_uq" ON "nedostupne_resolved" USING btree ("variant_code");