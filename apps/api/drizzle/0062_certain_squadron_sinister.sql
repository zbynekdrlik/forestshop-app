ALTER TABLE "daily_task" ADD COLUMN "audio" "bytea";--> statement-breakpoint
ALTER TABLE "daily_task" ADD COLUMN "audio_mime" text;--> statement-breakpoint
ALTER TABLE "daily_task" ADD COLUMN "audio_duration_ms" integer;