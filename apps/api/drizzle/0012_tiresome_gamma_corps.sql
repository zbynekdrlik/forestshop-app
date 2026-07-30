CREATE TABLE "order_open_status" (
	"status_name" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "status_name" text DEFAULT 'Vybavuje sa' NOT NULL;
--> statement-breakpoint
-- issue 59: sensible default seed — bez tohto riadku by appka hneď po
-- nasadení (predtým, než správca čokoľvek nastaví) zobrazovala "Na
-- objednanie" prázdne pre KAŽDÚ objednávku (žiadny nakonfigurovaný otvorený
-- stav = nič sa nezhoduje), presne opak toho, čo má byť predvolené správanie
-- (rovnaké ako stará appka: "Vybavuje sa"). "ON CONFLICT DO NOTHING" robí
-- migráciu bezpečne opakovateľnou, keby niekedy bežala nad DB, ktorá už tento
-- riadok má.
INSERT INTO "order_open_status" ("status_name") VALUES ('Vybavuje sa') ON CONFLICT ("status_name") DO NOTHING;