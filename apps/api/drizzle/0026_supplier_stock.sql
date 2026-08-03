CREATE TYPE "public"."supplier_availability" AS ENUM('available', 'unavailable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."supplier_stock_source" AS ENUM('json_ld', 'meta', 'text', 'none');--> statement-breakpoint
CREATE TABLE "supplier_stock" (
	"link" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"availability" "supplier_availability" NOT NULL,
	"availability_text" text DEFAULT '' NOT NULL,
	"price" numeric(12, 2),
	"source" "supplier_stock_source" NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"http_status" integer,
	"checked_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "supplier_stock_host_idx" ON "supplier_stock" USING btree ("host");--> statement-breakpoint
CREATE INDEX "supplier_stock_avail_idx" ON "supplier_stock" USING btree ("availability");