CREATE TYPE "public"."pairing_state" AS ENUM('navrhnute', 'potvrdene');--> statement-breakpoint
CREATE TABLE "pairing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_code" text NOT NULL,
	"supplier_url" text,
	"state" "pairing_state" DEFAULT 'navrhnute' NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_variant_code_unique" UNIQUE("variant_code"),
	CONSTRAINT "pairing_confirmation_ck" CHECK (("pairing"."state" = 'potvrdene') = ("pairing"."confirmed_by" IS NOT NULL AND "pairing"."confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"name" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"wholesale_base_url" text,
	"adapter_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_variant_code_variant_code_fk" FOREIGN KEY ("variant_code") REFERENCES "public"."variant"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pairing_state_idx" ON "pairing" USING btree ("state");