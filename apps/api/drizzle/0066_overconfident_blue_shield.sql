ALTER TABLE "order_line" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order_line" ALTER COLUMN "state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_note_product" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "floor_note_product" ALTER COLUMN "state" DROP NOT NULL;--> statement-breakpoint
-- issue 579 (Štěpán, Discord Develop-ÚLOHY): jednorazový RESET existujúcich
-- riadkov zo stavu `objednane` na NULL (neoznačený). Dnešný `objednane` (dnes
-- label „Nemáme", issue 577) bol NOT NULL DEFAULT, teda z ~99 % nikým vedome
-- neklikaný default — Štěpán chce začať označovať stavy odznova od
-- NEOZNAČENÉHO východiskového stavu („ani jeden stav nie je označený, ja potom
-- začnem označovať"). Vedome zvolené `objednane` (Nemáme) sa od NEOZNAČENÉHO
-- odteraz odlišuje tým, že ho manažér klikne po tejto migrácii. Enum sa
-- NEMENÍ (žiadny ADD VALUE, žiadna 55P04 pasca — `.claude/rules/database.md`).
UPDATE "order_line" SET "state" = NULL WHERE "state" = 'objednane';--> statement-breakpoint
UPDATE "floor_note_product" SET "state" = NULL WHERE "state" = 'objednane';
