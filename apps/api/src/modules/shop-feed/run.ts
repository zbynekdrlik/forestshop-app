// Nočné obnovenie mapy „kód → adresa" z feedu pre porovnávače (issue 220).

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { shopProductUrl } from "../../db/schema.js";
import { MIN_ENTRIES } from "./constants.js";
import { parseShopFeed } from "./parse.js";

export interface ShopFeedRunResult {
  /** Koľko použiteľných dvojíc kód/adresa feed obsahoval. */
  readonly entries: number;
  /** Koľko riadkov je v mape po zápise. */
  readonly stored: number;
}

/** Stiahne telo feedu. Vstrekované, aby testy nikdy nešli na živý e-shop. */
export type ShopFeedFetcher = () => Promise<string>;

export interface RunShopFeedOptions {
  readonly db: Database;
  readonly now: Date;
  readonly fetchFeed: ShopFeedFetcher;
}

// Zápis po dávkach — jeden `insert` so 7 666 riadkami prekročí limit
// parametrov na dopyt.
const CHUNK = 500;

export async function runShopFeed(options: RunShopFeedOptions): Promise<ShopFeedRunResult> {
  const { db, now, fetchFeed } = options;
  const rows = parseShopFeed(await fetchFeed());

  // Poistka PRED zápisom: pokazený feed nesmie mapu vyprázdniť. Kým beh
  // skončí chybou, na obrazovke ostanú adresy z posledného dobrého behu.
  if (rows.length < MIN_ENTRIES) {
    throw new Error(
      `Feed obsahoval len ${String(rows.length)} použiteľných položiek (očakávaných aspoň ${String(MIN_ENTRIES)}) — mapa adries sa neprepisuje`,
    );
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((row) => ({ ...row, fetchedAt: now, source: "feed" as const }));
    await db
      .insert(shopProductUrl)
      .values(chunk)
      .onConflictDoUpdate({
        target: shopProductUrl.code,
        set: {
          url: sql`excluded.url`,
          // issue 226: dostupnosť sa PREPÍŠE na aktuálnu hodnotu z tohto behu
          // (vrátane NULL, keď feed teraz nesie prázdnu značku) — inak by
          // stará hodnota z predošlého behu tíško prežívala a krížová
          // kontrola by porovnávala proti zastaranému signálu.
          availability: sql`excluded.availability`,
          // issue 347: obrázok sa PREPÍŠE na aktuálnu hodnotu z tohto behu
          // (vrátane NULL), rovnaká disciplína ako `availability` vyššie —
          // inak by stará adresa obrázka z predošlého behu ticho prežívala.
          imageUrl: sql`excluded.image_url`,
          fetchedAt: sql`excluded.fetched_at`,
          // issue 402: feed je AUTORITATÍVNY — kód, čo `shop-sitemap`u
          // predtým doplnil (`source: 'sitemap'/'probe'`), sa PREPÍŠE späť
          // na `'feed'`, hneď ako ho feed odteraz sám pokrýva. Bez tohto by
          // `source` ostal na starej hodnote a `shop-sitemap`'s populačný
          // dopyt (`select.ts`) by taký kód mylne stále považoval za "mimo
          // feedu".
          source: sql`excluded.source`,
        },
      });
  }

  // Riadky, ktoré feed už neobsahuje, sa ZÁMERNE nemažú: produkt vypadnutý z
  // feedu (napr. dočasne skrytý) má stále platnú adresu a je lepšie ukázať ju,
  // než spadnúť späť na vyhľadávanie.
  const [count] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(shopProductUrl);

  return { entries: rows.length, stored: count?.value ?? 0 };
}
