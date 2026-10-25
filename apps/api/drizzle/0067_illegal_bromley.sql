ALTER TYPE "public"."upozornenie_type" ADD VALUE 'shoptet_blokovanie';--> statement-breakpoint
CREATE TABLE "shop_sitemap_probe_attempt" (
	"product_key" text PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL
);
