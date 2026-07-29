CREATE TYPE "public"."order_line_state" AS ENUM('objednane', 'caka_sa', 'skladom', 'nedostupne');--> statement-breakpoint
CREATE TABLE "order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_code" text NOT NULL,
	"quantity" integer NOT NULL,
	"state" "order_line_state" DEFAULT 'objednane' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_line_quantity_positive_ck" CHECK ("order_line"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_order_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"comment" text,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_external_order_id_unique" UNIQUE("external_order_id")
);
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_variant_code_variant_code_fk" FOREIGN KEY ("variant_code") REFERENCES "public"."variant"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_line_order_idx" ON "order_line" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_line_variant_idx" ON "order_line" USING btree ("variant_code");--> statement-breakpoint
CREATE INDEX "order_line_state_idx" ON "order_line" USING btree ("state");--> statement-breakpoint
CREATE INDEX "order_placed_at_idx" ON "order" USING btree ("placed_at");