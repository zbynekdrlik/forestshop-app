import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orderOpenStatuses, orders, users } from "../src/db/schema.js";
import { listOpenOrderLinesBySupplier } from "../src/modules/orders/queries.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";
import {
  listKnownStatusNames,
  listOpenStatusNames,
  replaceOpenStatusNames,
} from "../src/modules/orders/open-statuses.js";

// `auditEvents.actorUserId` má FK na `users.id` (`record`, `modules/audit/
// service.ts`) — testy, ktoré skutočne PÍŠU audit záznam, potrebujú REÁLNy
// riadok v `users`, rovnaký vzor ako `orders-state-lock.integration.test.ts`
// ("x" ako heslo, nikdy sa v tomto teste neoveruje).
async function insertTestUser(db: Awaited<ReturnType<typeof withCleanDb>>["db"]): Promise<string> {
  const [pouzivatel] = await db
    .insert(users)
    .values({ email: "aktor@forestshop.sk", passwordHash: "x", displayName: "Aktor", role: "manazer" })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("insert používateľa zlyhal");
  return pouzivatel.id;
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

// issue 59: `listOpenOrderLinesBySupplier` musí ukázať LEN objednávky, ktorých
// `order.status_name` je v nastavenom otvorenom zozname — objednávka so
// stavom mimo neho ("Vybavená") sa v "Na objednanie" nesmie objaviť vôbec,
// bez ohľadu na to, v akom stave je jej `order_line.state` (ten je appkou/
// manažérom riadený nezávisle, viď `queries.ts`'s komentár).
it("zoznam 'Na objednanie' ukáže len objednávky s nastaveným otvoreným stavom, uzavretá objednávka zmizne", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");

  const [otvorena] = await db
    .insert(orders)
    .values({
      externalOrderId: "8001",
      customerName: "Zákazník otvorenej",
      statusName: "Vybavuje sa",
      placedAt: new Date("2026-07-01T00:00:00Z"),
    })
    .returning();
  if (otvorena === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: otvorena.id, variantCode: "A-1", quantity: 1 });

  const [uzavreta] = await db
    .insert(orders)
    .values({
      externalOrderId: "8002",
      customerName: "Zákazník uzavretej",
      statusName: "Vybavená",
      placedAt: new Date("2026-07-02T00:00:00Z"),
    })
    .returning();
  if (uzavreta === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: uzavreta.id, variantCode: "A-1", quantity: 1 });

  const suppliers = await listOpenOrderLinesBySupplier(db, "https://test.example");
  const alfa = suppliers.find((s) => s.supplier === "Dodávateľ Alfa");
  expect(alfa?.lines.map((l) => l.externalOrderId)).toEqual(["8001"]);
});

it("bez nastaveného otvoreného stavu (prázdny order_open_status) sa vráti prázdny zoznam, nikdy nepadne", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "8003", customerName: "Zákazník", placedAt: new Date("2026-07-03T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "A-1", quantity: 1 });

  await db.delete(orderOpenStatuses);

  const suppliers = await listOpenOrderLinesBySupplier(db, "https://test.example");
  expect(suppliers).toEqual([]);
});

it("replaceOpenStatusNames vyčistí vstup (orez, NFC, duplicity, prázdne) a zapíše audit", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;
  const aktorId = await insertTestUser(db);

  const vysledok = await replaceOpenStatusNames(db, {
    statuses: ["  Vybavuje sa  ", "Vybavuje sa", "", "   ", "Osob. odber"],
    actorUserId: aktorId,
    now: new Date("2026-07-30T12:00:00Z"),
  });
  expect(vysledok).toEqual({ status: "ok", statuses: ["Vybavuje sa", "Osob. odber"] });

  expect(await listOpenStatusNames(db)).toEqual(["Osob. odber", "Vybavuje sa"]); // abecedne

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "order_open_status.changed");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(aktorId);
  expect(udalost?.data).toMatchObject({ statuses: ["Vybavuje sa", "Osob. odber"] });
});

it("replaceOpenStatusNames odmietne zoznam, ktorý je po vyčistení prázdny — nesmie natrvalo vyprázdniť 'Na objednanie'", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;
  const aktorId = await insertTestUser(db);

  const povodne = await listOpenStatusNames(db);
  const vysledok = await replaceOpenStatusNames(db, {
    statuses: ["   ", ""],
    actorUserId: aktorId,
    now: new Date("2026-07-30T12:00:00Z"),
  });
  expect(vysledok).toEqual({ status: "empty" });
  expect(await listOpenStatusNames(db)).toEqual(povodne); // nezmenené
});

it("listKnownStatusNames vráti distinct statusName reálne videné v objednávkach, bez prázdnych", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  await db.insert(orders).values([
    { externalOrderId: "8101", customerName: "X", statusName: "Vybavuje sa", placedAt: new Date("2026-07-01T00:00:00Z") },
    { externalOrderId: "8102", customerName: "Y", statusName: "Vybavená", placedAt: new Date("2026-07-02T00:00:00Z") },
    { externalOrderId: "8103", customerName: "Z", statusName: "Vybavuje sa", placedAt: new Date("2026-07-03T00:00:00Z") },
  ]);

  expect(await listKnownStatusNames(db)).toEqual(["Vybavená", "Vybavuje sa"]);
});
