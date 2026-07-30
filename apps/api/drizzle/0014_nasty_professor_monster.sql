CREATE TABLE "product_supplier_override" (
	"product_key" text PRIMARY KEY NOT NULL,
	"supplier" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_supplier_override" ADD CONSTRAINT "product_supplier_override_product_key_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."product"("key") ON DELETE cascade ON UPDATE no action;