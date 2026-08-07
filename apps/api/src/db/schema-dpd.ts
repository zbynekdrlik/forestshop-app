import { date, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orders } from "./schema-orders.js";

// issue 292: appka-VLASTNÝ záznam každého pokusu vytvoriť DPD zásielku
// (nikdy Shoptetovo pole, nikdy re-importom prepísané) — na rozdiel od
// `order.package_number` (Shoptetov vlastný, coalesce-refreshed stĺpec),
// toto je appkina vlastná história pokusov cez `dpdshipper.sk` robota.
export const dpdOperationStatus = pgEnum("dpd_operation_status", ["submitted", "failed"]);

// Jeden riadok NA OBJEDNÁVKU (`orderId` unique) — opakovaný pokus (retry po
// zlyhaní) PREPÍŠE ten istý riadok (upsert podľa `orderId`), appka teda vždy
// vidí LEN posledný pokus pre danú objednávku, nikdy celú históriu pokusov
// (MVP — netreba viac, `modules/dpd/queries.ts`'s "pripravené na odoslanie"
// zoznam číta len `status`).
export const dpdShipments = pgTable(
  "dpd_shipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: dpdOperationStatus("status").notNull(),
    // Vyplnené len pri `status = 'submitted'` — číslo zásielky prečítané z
    // portálu po úspešnom založení, appka ho ukáže na obrazovke na
    // sledovanie.
    parcelNumber: text("parcel_number"),
    // Hmotnosť SKUTOČNE odoslaná robotom (obsluha ju mohla v náhľade
    // upraviť oproti `order.weight`) — appka si ju pamätá kvôli auditu, aj
    // keď sa pôvodná hodnota na objednávke neskôr zmení.
    weightKg: numeric("weight_kg", { precision: 10, scale: 2 }).notNull(),
    // Dobierková suma SKUTOČNE odoslaná robotom, `null` = nebola to dobierka.
    codAmount: numeric("cod_amount", { precision: 12, scale: 2 }),
    // Vyplnené len pri `status = 'failed'` — dôvod zlyhania (chyba z
    // portálu, timeout, nenájdený formulár…).
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dpd_shipment_order_uq").on(t.orderId)],
);

// issue 292: "Objednať zvoz na deň" — jednorazový zvoz kuriéra NIE JE
// viazaný na konkrétnu objednávku (portál ho objednáva na CELÚ zvozovú
// adresu naraz, `.claude/rules/dpd.md`) — samostatná tabuľka, žiadny FK na
// `order`.
export const dpdPickupRequests = pgTable("dpd_pickup_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  pickupDate: date("pickup_date").notNull(),
  status: dpdOperationStatus("status").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
