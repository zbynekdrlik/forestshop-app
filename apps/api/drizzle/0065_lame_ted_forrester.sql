ALTER TABLE "floor_note_product" ADD COLUMN "state" "order_line_state" DEFAULT 'objednane' NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_note_product" ADD COLUMN "comment" text;