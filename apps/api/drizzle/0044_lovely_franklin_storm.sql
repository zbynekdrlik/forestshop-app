CREATE TYPE "public"."dpd_operation_status" AS ENUM('submitted', 'failed');--> statement-breakpoint
CREATE TABLE "dpd_pickup_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pickup_date" date NOT NULL,
	"status" "dpd_operation_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dpd_shipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "dpd_operation_status" NOT NULL,
	"parcel_number" text,
	"weight_kg" numeric(10, 2) NOT NULL,
	"cod_amount" numeric(12, 2),
	"error_message" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_full_name" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_company" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_street" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_house_number" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_city" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_zip" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivery_country_name" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "weight" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "payment_method_name" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "price_to_pay" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "dpd_shipment" ADD CONSTRAINT "dpd_shipment_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dpd_shipment_order_uq" ON "dpd_shipment" USING btree ("order_id");