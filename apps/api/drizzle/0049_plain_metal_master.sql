CREATE TABLE "pairing_state_writeback_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
