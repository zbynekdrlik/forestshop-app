CREATE TABLE "floor_note_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"floor_note_id" uuid NOT NULL,
	"variant_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "floor_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"ordered" boolean DEFAULT false NOT NULL,
	"called" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "floor_note_product" ADD CONSTRAINT "floor_note_product_floor_note_id_floor_note_id_fk" FOREIGN KEY ("floor_note_id") REFERENCES "public"."floor_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_note_product" ADD CONSTRAINT "floor_note_product_variant_code_variant_code_fk" FOREIGN KEY ("variant_code") REFERENCES "public"."variant"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_note" ADD CONSTRAINT "floor_note_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "floor_note_product_note_idx" ON "floor_note_product" USING btree ("floor_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "floor_note_product_note_variant_uq" ON "floor_note_product" USING btree ("floor_note_id","variant_code");--> statement-breakpoint
CREATE INDEX "floor_note_created_at_idx" ON "floor_note" USING btree ("created_at");