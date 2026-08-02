CREATE TABLE "posta_uncollected_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posta_uncollected_state" (
	"order_code" text PRIMARY KEY NOT NULL,
	"notify_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" date,
	"terminal_state" text,
	"terminal_at" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "package_number" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_carrier_name" text;--> statement-breakpoint
-- issue 172: singleton riadok MUSÍ existovať hneď po nasadení — appka
-- kontroluje "enabled" pri KAŽDOM naplánovanom behu, žiadny riadok by
-- znamenal, že kontrola nemá čo prečítať. `enabled = false` je jediná
-- bezpečná predvolená hodnota (žiadny e-mail bez ručného zapnutia
-- majiteľom) — DEFAULT stĺpca to zaisťuje aj tu. "ON CONFLICT DO NOTHING"
-- robí migráciu bezpečne opakovateľnou.
INSERT INTO "posta_uncollected_settings" ("id", "enabled") VALUES ('default', false) ON CONFLICT ("id") DO NOTHING;