CREATE TABLE "product_supplier_link_override" (
	"product_key" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_supplier_link_override" ADD CONSTRAINT "product_supplier_link_override_product_key_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."product"("key") ON DELETE cascade ON UPDATE no action;