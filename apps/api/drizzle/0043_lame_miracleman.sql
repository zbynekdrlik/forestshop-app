ALTER TABLE "order" ADD COLUMN "claim_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "claim_note" text;