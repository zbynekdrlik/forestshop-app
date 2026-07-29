CREATE TYPE "public"."ingest_issue_kind" AS ENUM('empty_code', 'duplicate_code', 'invalid_money', 'missing_currency', 'invalid_stock', 'product_name_conflict');--> statement-breakpoint
CREATE TYPE "public"."snapshot_verdict" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."variant_state" AS ENUM('sellable', 'out_of_stock', 'discontinued');--> statement-breakpoint
CREATE TABLE "catalog_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source_label" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"row_count" integer NOT NULL,
	"columns" jsonb NOT NULL,
	"verdict" "snapshot_verdict" NOT NULL,
	"rejection_reason" text,
	"raw_path" text,
	"variant_count" integer,
	"product_count" integer,
	"issue_count" integer,
	CONSTRAINT "catalog_snapshot_reason_ck" CHECK (("catalog_snapshot"."verdict" = 'rejected') = ("catalog_snapshot"."rejection_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ingest_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"kind" "ingest_issue_kind" NOT NULL,
	"code" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"supplier" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_seen_snapshot_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant" (
	"code" text PRIMARY KEY NOT NULL,
	"product_key" text NOT NULL,
	"size_label" text,
	"pair_code" text,
	"name" text NOT NULL,
	"currency" text,
	"price" numeric(12, 2),
	"standard_price" numeric(12, 2),
	"purchase_price" numeric(12, 2),
	"action_price" numeric(12, 2),
	"action_from" date,
	"action_until" date,
	"percent_vat" numeric(5, 2),
	"including_vat" boolean,
	"stock" integer NOT NULL,
	"availability_in_stock_text" text NOT NULL,
	"availability_out_of_stock_text" text NOT NULL,
	"availability_text" text NOT NULL,
	"product_visibility" text NOT NULL,
	"state" "variant_state" NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_seen_snapshot_id" uuid NOT NULL,
	"missing_since" timestamp with time zone,
	CONSTRAINT "variant_money_needs_currency_ck" CHECK ("variant"."currency" IS NOT NULL OR ("variant"."price" IS NULL AND "variant"."standard_price" IS NULL AND "variant"."purchase_price" IS NULL AND "variant"."action_price" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ingest_issue" ADD CONSTRAINT "ingest_issue_snapshot_id_catalog_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."catalog_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_last_seen_snapshot_id_catalog_snapshot_id_fk" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "public"."catalog_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_product_key_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."product"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_last_seen_snapshot_id_catalog_snapshot_id_fk" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "public"."catalog_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_snapshot_fetched_at_idx" ON "catalog_snapshot" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_snapshot_accepted_sha_uq" ON "catalog_snapshot" USING btree ("content_sha256") WHERE "catalog_snapshot"."verdict" = 'accepted';--> statement-breakpoint
CREATE INDEX "ingest_issue_snapshot_idx" ON "ingest_issue" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "product_supplier_idx" ON "product" USING btree ("supplier");--> statement-breakpoint
CREATE INDEX "variant_product_idx" ON "variant" USING btree ("product_key");--> statement-breakpoint
CREATE INDEX "variant_state_idx" ON "variant" USING btree ("state");--> statement-breakpoint
CREATE INDEX "variant_name_idx" ON "variant" USING btree ("name");