import { customType } from "drizzle-orm/pg-core";

// Zdieľaný `bytea` stĺpcový typ pre binárne dáta ukladané priamo na riadku
// (prvé použitie #519 pre `daily_task.audio`, ďalšie #543 pre
// `slavosport_payment_scan.image`). node-postgres nesie/prijíma `bytea` ako
// `Buffer` bez extra serializácie. Vydelené do vlastného modulu, aby sa
// definícia neduplikovala naprieč `schema-*.ts` súbormi.
//
// POZOR (`.claude/rules/daily-tasks.md`): `bytea` stĺpec sa NIKDY nevyberá do
// ZOZNAMU/odznaku — inak sa poll nafúkne na megabajty. Bajty sa vždy streamujú
// samostatnou trasou pre jeden riadok.
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
