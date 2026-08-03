CREATE TABLE "restock_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"variant_code" text NOT NULL,
	"pair_code" text,
	"product_name" text NOT NULL,
	"supplier" text,
	"supplier_link" text NOT NULL,
	"supplier_availability_text" text DEFAULT '' NOT NULL,
	"supplier_price" numeric(12, 2),
	"confirmed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restock_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "restock_event_at_idx" ON "restock_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "restock_event_variant_idx" ON "restock_event" USING btree ("variant_code");