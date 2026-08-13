CREATE TYPE "public"."pairing_confidence" AS ENUM('high', 'medium', 'low', 'none');--> statement-breakpoint
CREATE TYPE "public"."pairing_verdict" AS ENUM('ok', 'unsure');--> statement-breakpoint
CREATE TABLE "pairing_candidate_set" (
	"product_key" text PRIMARY KEY NOT NULL,
	"gathered_at" timestamp with time zone NOT NULL,
	"queries" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"chosen_url" text,
	"chosen_reason" text,
	"confidence" "pairing_confidence" NOT NULL,
	"verdict" "pairing_verdict",
	"verdict_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_key" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"code" text,
	"price" numeric(12, 2),
	"raw_score" numeric(8, 4) NOT NULL,
	"code_hit" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_search_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing_candidate_set" ADD CONSTRAINT "pairing_candidate_set_product_key_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."product"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_candidate" ADD CONSTRAINT "pairing_candidate_product_key_fk" FOREIGN KEY ("product_key") REFERENCES "public"."pairing_candidate_set"("product_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_candidate_product_url_uq" ON "pairing_candidate" USING btree ("product_key","url");--> statement-breakpoint
CREATE INDEX "pairing_candidate_product_idx" ON "pairing_candidate" USING btree ("product_key");--> statement-breakpoint
-- issue 387 E3: "suppliers" (schema-pairing.ts, #44) UŽ EXISTUJE, len bola
-- doteraz prázdna ("adapter_key konečne dostane využitie" — návrh, sekcia
-- "Existujúce tabuľky"). Seeduje/upsertne presne 3 riadky, kľúčované
-- rovnakým veľkými-písmenami tvarom mena, aký stará appka používala ako kľúč
-- do svojho config.py's SUPPLIERS dictu (overené v config.py priamo,
-- issue 387 komentár "overenie platnosti"). ON CONFLICT DO UPDATE (nie DO
-- NOTHING) — keby riadok pre daného dodávateľa už existoval (napr. založený
-- ručne pri katalógovej práci pred E3), tento seed len DOPLNÍ/OPRAVÍ
-- adapter_key + wholesale_base_url, nikdy nezduplikuje riadok (presne podľa
-- zadania "možno už existujú z katalógu — potom len doplň adapter_key,
-- neduplikuj"). "currency" sa pri konflikte NEPREPISUJE (mohla byť ručne
-- nastavená inak), len pri INSERTe dostáva predvolené 'EUR'.
INSERT INTO "supplier" ("name", "currency", "wholesale_base_url", "adapter_key") VALUES
	('WETLAND', 'EUR', 'https://www.wetland.sk', 'wetland'),
	('BETALOV', 'EUR', 'https://www.huntingshop.eu', 'betalov'),
	('ODIMON', 'EUR', 'https://www.odimon.sk', 'odimon')
ON CONFLICT ("name") DO UPDATE SET
	"adapter_key" = excluded."adapter_key",
	"wholesale_base_url" = excluded."wholesale_base_url";