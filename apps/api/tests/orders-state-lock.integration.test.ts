import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orders, users } from "../src/db/schema.js";
import { setOrderLineState } from "../src/modules/orders/state.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Code-review finding on #25: `setOrderLineState`'s SELECT (ktorý číta
// pôvodný stav pre auditový `from`) pôvodne nebol chránený riadkovým zámkom
// — dve súbežné zmeny stavu TOHO ISTÉHO riadku mohli zapísať audit s
// nesprávnym `from` (druhá transakcia by prečítala stav SPRED prvej zmeny,
// nie tesne pred vlastným zápisom), hoci samotný stĺpec `state` by aj tak
// skončil správne (posledný zápis vyhráva). Test to dokazuje
// DETERMINISTICKY: druhé pripojenie podrží `SELECT ... FOR UPDATE` na tom
// istom riadku v otvorenej (necommitnutej) transakcii — `setOrderLineState`
// sa musí na svojom vlastnom `.for("update")` zaseknúť presne na tomto
// mieste, kým druhé pripojenie neskôr riadok zmení a commitne. Bez zámku
// (pôvodná chyba) by obyčajný SELECT nebol blokovaný vôbec (v Postgrese
// obyčajné čítanie nikdy nečaká na riadkový zámok inej transakcie) a
// videl by ZASTARANÝ stav spred zmeny.

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

it("súbežná zmena stavu čaká na riadkový zámok — audit 'from' odráža ČERSTVÝ stav, nie zastaraný", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  const [pouzivatel] = await db
    .insert(users)
    .values({
      email: "manazer-lock-test@forestshop.sk",
      passwordHash: "x", // FK potrebuje existujúci riadok, heslo sa v tomto teste nikdy neoveruje
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("insert používateľa zlyhal");

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "5001", customerName: "Zákazník", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const [riadok] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "A-1", quantity: 1 }) // default state: "objednane"
    .returning();
  if (riadok === undefined) throw new Error("insert riadku zlyhal");

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const rawClient = new pg.Client({ connectionString: databaseUrl });
  await rawClient.connect();
  await rawClient.query("BEGIN");
  // Podrží riadkový zámok presne na tom istom riadku, aký `setOrderLineState`
  // sám žiada cez `.for("update")`.
  await rawClient.query('SELECT state FROM order_line WHERE id = $1 FOR UPDATE', [riadok.id]);

  try {
    const concurrentChange = setOrderLineState(db, {
      lineId: riadok.id,
      newState: "skladom",
      actorUserId: pouzivatel.id,
      now: new Date("2026-07-30T10:00:00Z"),
    });

    // Dá `concurrentChange`'s vlastnému `.for("update")` selectu dosť času
    // dôjsť k riadkovému zámku a zaseknúť sa naň — zámok drží `rawClient`,
    // takže "príliš neskoro" tu nehrozí, len čakáme, kým sa naň naozaj zasekne.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Simuluje "prvú" súbežnú zmenu, ktorá stihla commitnúť MEDZITÝM — priamo,
    // mimo `setOrderLineState`, presne v momente, keď je druhá zaseknutá na
    // zámku.
    await rawClient.query('UPDATE order_line SET state = $1 WHERE id = $2', ["caka_sa", riadok.id]);
    await rawClient.query("COMMIT");

    const result = await concurrentChange;
    expect(result).toBe("ok");

    const udalosti = await db.select().from(auditEvents);
    const udalost = udalosti.find((e) => e.action === "order_line.state.changed" && e.entityId === riadok.id);
    expect(udalost).toBeDefined();
    // Dôkaz opravy: `from` je "caka_sa" (stav COMMITNUTÝ tesne pred týmto
    // zápisom), NIE "objednane" (pôvodný, zastaraný stav spred súbežnej
    // zmeny) — presne to, čo `.for("update")` zaručuje.
    expect(udalost?.data).toMatchObject({ from: "caka_sa", to: "skladom" });
  } finally {
    await rawClient.end();
  }
});
