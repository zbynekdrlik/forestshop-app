import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { upozornenie, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import {
  cancelPostpone,
  createOwnNote,
  deleteUpozornenie,
  markAllSeen,
  postponeUpozornenie,
  resolveUpozornenie,
  updateOwnNote,
  upsertUpozornenie,
} from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 267: "Upozornenia" — service-level testy (bez HTTP vrstvy) pre
// zdieľanú zapisovaciu cestu (`upsertUpozornenie`) a per-kartové akcie.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function bootDb() {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [user] = await ctx.db
    .insert(users)
    .values({ email: "majitel@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  return { db: ctx.db, userId: user.id };
}

describe("upsertUpozornenie", () => {
  it("bez dedupKey vždy VLOŽÍ nový riadok (vlastné poznámky nikdy nekolidujú)", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const a = await createOwnNote(db, { title: "Schôdzka v stredu", createdByUserId: userId, now });
    const b = await createOwnNote(db, { title: "Vybaviť poistku", createdByUserId: userId, now });
    expect(a.id).not.toBe(b.id);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(2);
  });

  it("s rovnakým dedupKey OBNOVÍ existujúci nevyriešený riadok namiesto duplicity", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const first = await upsertUpozornenie(db, {
      type: "vlastna_poznamka",
      source: "appka",
      title: "Zásielka čaká na pošte — 3 dni",
      dedupKey: "posta:EF123456789SK",
      now,
    });
    const later = new Date("2026-08-06T08:00:00Z");
    const second = await upsertUpozornenie(db, {
      type: "vlastna_poznamka",
      source: "appka",
      title: "Zásielka čaká na pošte — 4 dni",
      dedupKey: "posta:EF123456789SK",
      now: later,
    });
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Zásielka čaká na pošte — 4 dni");
    // Pôvodný `createdAt` sa NEMENÍ pri obnove (len UPDATE polí, nie nový insert).
    expect(rows[0]?.createdAt.toISOString()).toBe(now.toISOString());
  });

  it("s rovnakým dedupKey, ale existujúci riadok je UŽ VYRIEŠENÝ, vloží NOVÝ riadok (nezruší vyriešenie starého)", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const first = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Prvá vlna", dedupKey: "posta:X", now });
    await resolveUpozornenie(db, { id: first.id, resolvedByUserId: userId, now });
    const second = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Nová vlna", dedupKey: "posta:X", now });
    expect(second.id).not.toBe(first.id);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(2);
  });

  it("obnova NEPRESUNIE odloženie ani stav videnia nastavené majiteľom", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Pôvodný text", dedupKey: "posta:Y", now });
    await postponeUpozornenie(db, { id: created.id, postponedUntil: new Date("2026-08-20T00:00:00Z"), now });
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Obnovený text", dedupKey: "posta:Y", now });
    const [row] = await db.select().from(upozornenie);
    expect(row?.title).toBe("Obnovený text");
    expect(row?.postponedUntil?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });
});

// issue 272: TOCTOU race na `dedupKey` — dve súbežné volania s tým istým,
// dosiaľ nepoužitým `dedupKey` (žiadny existujúci riadok) nesmú nikdy
// vyhodiť unique-violation ani vyrobiť dva riadky. Na starom kóde (SELECT,
// potom podmienený UPDATE/INSERT) obe volania uvidia "žiadny riadok" pri
// svojom SELECTe skôr, než ktorékoľvek stihne INSERT — druhé INSERT-ne
// narazí na `upozornenie_dedup_key_uq` a `Promise.all` zamietne s chybou
// databázy.
//
// **Pool sa musí PREDHRIAŤ pred štartom závodu** — inak sa "závod" v praxi
// nikdy nestretne: na studenom pripojení dominuje latencia TCP handshaku
// (~15-20ms na tomto Dockeri) nad latenciou samotného SQL dopytu (~3ms), takže
// prvé volanie, ktoré náhodou dostane pripojenie skôr, stihne CELÝ
// SELECT+INSERT cyklus skôr, než ostatné vôbec stihnú odoslať svoj SELECT —
// žiadny skutočný závod, test by ticho prešiel aj na chybnom kóde (overené
// priamym `pg.Pool` pokusom mimo vitestu: bez predhriatia 5/5 "OK", s
// predhriatím 2/5 "duplicate key" na starom kóde). `select 1` na `N`
// súbežných pripojeniach vopred zabezpečí `N` HOTOVÝCH (idle) pripojení v
// poole, takže samotný závod už pretekáva len o rýchlosť SQL, nie o
// pripojenie.
//
// Code review (issue 272/268): ANI predhriaty pool nezaručuje 100 % zásah pri
// KAŽDOM behu (namerané 2/5 na jednom behu starého kódu) — je to inherentná
// vlastnosť testovania závodu na reálnej DB, nie chyba opravy. `CONCURRENCY`
// je zámerne vyššie než najmenšie číslo, čo raz zafungovalo (5 → 10) — viac
// súčasných pokusov na TEN istý dedupKey zvyšuje šancu, že sa aspoň dva
// SELECTy naozaj prekryjú v jednom behu, takže prípadný BUDÚCI návrat k
// select-then-branch kódu má vyššiu šancu, že ho tento test chytí hneď pri
// prvom CI behu, nie až pri druhom/treťom.
describe("upsertUpozornenie — súbežnosť (issue 272)", () => {
  it("dve súbežné volania s rovnakým NOVÝM dedupKey nikdy nezlyhajú a vyrobia PRESNE jeden riadok", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const dedupKey = "posta:EF999999999SK";
    const CONCURRENCY = 10;

    await Promise.all(Array.from({ length: CONCURRENCY }, () => db.execute(sql`select 1`)));

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: `Pokus ${String(i)}`, dedupKey, now }),
      ),
    );

    const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, dedupKey));
    expect(rows).toHaveLength(1);
    // Všetkých 5 volaní muselo skončiť na TOM ISTOM riadku (atomický upsert).
    for (const r of results) expect(r.id).toBe(rows[0]?.id);
  });
});

describe("updateOwnNote — len zdroj 'vlastne'", () => {
  it("upraví vlastnú poznámku", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await createOwnNote(db, { title: "Pôvodný nadpis", createdByUserId: userId, now });
    const updated = await updateOwnNote(db, { id: created.id, title: "Nový nadpis", details: "detaily" });
    expect(updated).toBe(true);
    const [row] = await db.select().from(upozornenie);
    expect(row?.title).toBe("Nový nadpis");
    expect(row?.details).toBe("detaily");
  });

  it("NEUPRAVÍ kartu zo zdroja 'appka' (server-side vynútenie, nie len UI)", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Automatická karta", dedupKey: "posta:Z", now });
    const updated = await updateOwnNote(db, { id: created.id, title: "Pokus o úpravu" });
    expect(updated).toBe(false);
    const [row] = await db.select().from(upozornenie);
    expect(row?.title).toBe("Automatická karta");
  });
});

// issue 327: mazanie UŽ NIE JE obmedzené na `source === "vlastne"` (predtým
// `deleteOwnNote`, issue 267) — `deleteUpozornenie` maže KTORÚKOĽVEK kartu
// bez ohľadu na zdroj, viď `service.ts`'s odôvodnenie.
describe("deleteUpozornenie — všetky zdroje", () => {
  it("zmaže vlastnú poznámku", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const own = await createOwnNote(db, { title: "Zmazať ma", createdByUserId: userId, now });
    expect(await deleteUpozornenie(db, own.id)).toBe(true);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(0);
  });

  it("zmaže AJ kartu zo zdroja 'appka' (automatický zdroj)", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const appka = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "appka", title: "Automatická karta", dedupKey: "posta:W", now });
    expect(await deleteUpozornenie(db, appka.id)).toBe(true);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(0);
  });

  it("nezmaže INÚ kartu, len tú so zhodným id", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const own = await createOwnNote(db, { title: "Zmazať ma", createdByUserId: userId, now });
    const other = await createOwnNote(db, { title: "Nezmazať", createdByUserId: userId, now });
    expect(await deleteUpozornenie(db, own.id)).toBe(true);
    const rows = await db.select().from(upozornenie);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(other.id);
  });

  it("zmazanie neznámeho/už zmazaného id je neškodné (vracia false, nikdy nevyhodí)", async () => {
    const { db } = await bootDb();
    expect(await deleteUpozornenie(db, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("resolveUpozornenie / postponeUpozornenie", () => {
  it("vyriešenie NIKDY predtým nevidenej karty ju zároveň označí ako videnú", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await createOwnNote(db, { title: "Nikdy nevidená", createdByUserId: userId, now });
    await resolveUpozornenie(db, { id: created.id, resolvedByUserId: userId, now });
    const [row] = await db.select().from(upozornenie);
    expect(row?.resolvedAt?.toISOString()).toBe(now.toISOString());
    expect(row?.seenAt?.toISOString()).toBe(now.toISOString());
  });

  it("odloženie posunie 'vybaviť do' návratu a tiež kartu označí ako videnú", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await createOwnNote(db, { title: "Odložiť ma", createdByUserId: userId, now });
    const until = new Date("2026-08-12T00:00:00Z");
    expect(await postponeUpozornenie(db, { id: created.id, postponedUntil: until, now })).toBe(true);
    const [row] = await db.select().from(upozornenie);
    expect(row?.postponedUntil?.toISOString()).toBe(until.toISOString());
    expect(row?.seenAt).not.toBeNull();
  });
});

describe("cancelPostpone", () => {
  it("vynuluje 'postponedUntil' — karta prestane byť odložená (bez zásahu do seenAt)", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await createOwnNote(db, { title: "Odložiť ma", createdByUserId: userId, now });
    await postponeUpozornenie(db, { id: created.id, postponedUntil: new Date("2026-08-20T00:00:00Z"), now });

    expect(await cancelPostpone(db, { id: created.id })).toBe(true);
    const [row] = await db.select().from(upozornenie).where(eq(upozornenie.id, created.id));
    expect(row?.postponedUntil).toBeNull();
    expect(row?.seenAt).not.toBeNull();
  });

  it("neznáme id je neškodné (vracia false, nikdy nevyhodí)", async () => {
    const { db } = await bootDb();
    expect(await cancelPostpone(db, { id: "00000000-0000-0000-0000-000000000000" })).toBe(false);
  });
});

describe("markAllSeen", () => {
  it("označí VŠETKY nevidené karty naraz, nedotkne sa už videných", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-05T08:00:00Z");
    const a = await createOwnNote(db, { title: "A", createdByUserId: userId, now });
    const b = await createOwnNote(db, { title: "B", createdByUserId: userId, now });
    // "B" je už videná skôr (napr. z predošlého otvorenia záložky).
    await db.update(upozornenie).set({ seenAt: new Date("2026-08-04T00:00:00Z") }).where(eq(upozornenie.id, b.id));
    const marked = await markAllSeen(db, now);
    expect(marked).toBe(1);
    const rows = await db.select().from(upozornenie).orderBy(upozornenie.title);
    const aRow = rows.find((r) => r.id === a.id);
    const bRow = rows.find((r) => r.id === b.id);
    expect(aRow?.seenAt?.toISOString()).toBe(now.toISOString());
    expect(bRow?.seenAt?.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });
});
