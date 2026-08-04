-- issue 224: "supplier_stock" bola kľúčovaná len na "link" (jedna dostupnosť
-- pre celý odkaz) — pridáva sa "size_label" (default '' = celý odkaz, pre
-- spätnú kompatibilitu existujúcich riadkov) a primárny kľúč sa mení na
-- dvojicu (link, size_label), aby odkaz zdieľaný viacerými veľkosťami mohol
-- niesť dostupnosť KAŽDEJ veľkosti samostatne. drizzle-kit nevie automaticky
-- zistiť názov pôvodného PK — overené ručne v DB (`supplier_stock_pkey`).
ALTER TYPE "public"."supplier_stock_source" ADD VALUE 'size_list' BEFORE 'none';--> statement-breakpoint
ALTER TABLE "supplier_stock" ADD COLUMN "size_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_stock" DROP CONSTRAINT "supplier_stock_pkey";--> statement-breakpoint
ALTER TABLE "supplier_stock" ADD CONSTRAINT "supplier_stock_link_size_label_pk" PRIMARY KEY("link","size_label");