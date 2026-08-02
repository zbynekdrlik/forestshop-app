CREATE TABLE "order_reminder_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_reminder_state" (
	"order_code" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- issue 173: singleton riadok MUSÍ existovať hneď po nasadení — appka
-- kontroluje "enabled" pri KAŽDOM naplánovanom behu, žiadny riadok by
-- znamenal, že kontrola nemá čo prečítať. `enabled = false` je jediná
-- bezpečná predvolená hodnota (žiadny e-mail bez ručného zapnutia
-- majiteľom) — DEFAULT stĺpca to zaisťuje aj tu. "ON CONFLICT DO NOTHING"
-- robí migráciu bezpečne opakovateľnou (rovnaký vzor ako #172).
INSERT INTO "order_reminder_settings" ("id", "enabled") VALUES ('default', false) ON CONFLICT ("id") DO NOTHING;
