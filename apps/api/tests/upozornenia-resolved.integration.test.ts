import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { upozornenie, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { listResolvedUpozornenia, RESOLVED_LIST_LIMIT } from "../src/modules/upozornenia/queries.js";
import { autoResolveByDedupKey, resolveUpozornenie, returnUpozornenieToOpen, upsertUpozornenie } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 283 (majiteľ, komentár na tickete): záložka "Vybavené" — service-level
// testy pre `listResolvedUpozornenia` a `returnUpozornenieToOpen`, vydelené do
// VLASTNÉHO súboru (rovnaký dôvod ako iné rozdelenia v tomto adresári,
// `.claude/rules/testing.md`'s eslint `max-lines: 400`).

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
    .values({ email: "majitel-283@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ Testovací", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  return { db: ctx.db, userId: user.id };
}

describe("listResolvedUpozornenia", () => {
  it("vráti LEN vyriešené karty, zoradené od NAJNOVŠIE vyriešených", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const open = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Ešte otvorená", now });
    const first = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená skôr", now });
    const second = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená neskôr", now });
    await resolveUpozornenie(db, { id: first.id, resolvedByUserId: userId, now: new Date("2026-08-06T09:00:00Z") });
    await resolveUpozornenie(db, { id: second.id, resolvedByUserId: userId, now: new Date("2026-08-06T10:00:00Z") });
    void open;

    const rows = await listResolvedUpozornenia(db, now);
    expect(rows.map((r) => r.title)).toEqual(["Vyriešená neskôr", "Vyriešená skôr"]);
    expect(rows.every((r) => r.status === "vybavene")).toBe(true);
  });

  it("nesie meno toho, kto vybavil ručne, a 'null' pre AUTOMATICKY vybavenú kartu", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const manual = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Ručne vybavená", now });
    await resolveUpozornenie(db, { id: manual.id, resolvedByUserId: userId, now });
    await upsertUpozornenie(db, { type: "nevyzdvihnuta_zasielka", source: "appka", title: "Automaticky vybavená", dedupKey: "posta:AUTO1", now });
    await autoResolveByDedupKey(db, "posta:AUTO1", now);

    const rows = await listResolvedUpozornenia(db, now);
    const manualRow = rows.find((r) => r.title === "Ručne vybavená");
    const autoRow = rows.find((r) => r.title === "Automaticky vybavená");
    expect(manualRow?.resolvedByName).toBe("Majiteľ Testovací");
    expect(autoRow?.resolvedByName).toBeNull();
  });

  // Code review: predchádzajúca verzia overovala len `RESOLVED_LIST_LIMIT ===
  // 200` — prešla by aj keby samotné `.limit(...)` volanie v `queries.ts`
  // niekto omylom zmazal. Skutočný regresný dôkaz musí SKUTOČNE nasadiť viac
  // riadkov, než je cap, a overiť, že orezanie naozaj funguje aj SMEROVO
  // (najnovšie vyriešené prežijú, najstaršie orezané odpadnú).
  it("orezanie na RESOLVED_LIST_LIMIT (200) SKUTOČNE funguje — najstaršie vyriešené odpadnú, najnovšie ostanú", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const TOTAL = RESOLVED_LIST_LIMIT + 5;
    await db.insert(upozornenie).values(
      Array.from({ length: TOTAL }, (_, i) => ({
        type: "vlastna_poznamka" as const,
        source: "vlastne" as const,
        title: `Cap ${String(i)}`,
        resolvedAt: new Date(now.getTime() + i * 1000),
        createdAt: now,
      })),
    );

    const rows = await listResolvedUpozornenia(db, now);
    expect(rows).toHaveLength(RESOLVED_LIST_LIMIT);
    // Zoradené `resolvedAt DESC` — najnovšie (najvyššie i) prvé, najstaršie
    // (i < 5, orezané cap-om) medzi výsledkami VÔBEC nie sú.
    expect(rows[0]?.title).toBe(`Cap ${String(TOTAL - 1)}`);
    expect(rows[RESOLVED_LIST_LIMIT - 1]?.title).toBe(`Cap ${String(TOTAL - RESOLVED_LIST_LIMIT)}`);
    expect(rows.some((r) => r.title === "Cap 0")).toBe(false);
  });
});

describe("returnUpozornenieToOpen", () => {
  it("vráti vyriešenú kartu späť medzi otvorené — vyčistí resolvedAt aj resolvedByUserId", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Omylom vybavená", now });
    await resolveUpozornenie(db, { id: created.id, resolvedByUserId: userId, now });

    const result = await returnUpozornenieToOpen(db, { id: created.id });
    expect(result).toBe("returned");

    const [row] = await db.select().from(upozornenie).where(eq(upozornenie.id, created.id));
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedByUserId).toBeNull();
  });

  it("neznáme id je neškodné (vracia 'no_op', nikdy nevyhodí)", async () => {
    const { db } = await bootDb();
    const result = await returnUpozornenieToOpen(db, { id: "00000000-0000-0000-0000-000000000000" });
    expect(result).toBe("no_op");
  });

  it("karta, ktorá NIE JE vyriešená, je neškodné no-op (dvojklik)", async () => {
    const { db } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Stále otvorená", now });
    const result = await returnUpozornenieToOpen(db, { id: created.id });
    expect(result).toBe("no_op");
    const [row] = await db.select().from(upozornenie).where(eq(upozornenie.id, created.id));
    expect(row?.resolvedAt).toBeNull();
  });

  // issue 283 (majiteľova podmienka): index proti duplicitám je ČIASTOČNÝ
  // (platí len na nevybavené karty) — vrátenie karty späť sa MUSÍ zrozumiteľne
  // odmietnuť, keď na ten istý `dedupKey` medzitým vznikla NOVÁ otvorená karta
  // (napr. #269's `vratenie` — objednávka prešla znova do vrátkového stavu a
  // ďalší import obnovil/vytvoril otvorenú kartu skôr, než sa tá stará vrátila).
  it("kolízia s existujúcou OTVORENOU kartou rovnakého dedupKey sa odmietne ako 'collision', nikdy nespadne", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const dedupKey = "vratenie:20700001";
    const resolved = await upsertUpozornenie(db, { type: "vratenie", source: "appka", title: "Staršia vlna", dedupKey, now });
    await resolveUpozornenie(db, { id: resolved.id, resolvedByUserId: userId, now });
    // Nová otvorená karta pre ROVNAKÝ dedupKey (partial index ju dovolí, lebo
    // predchádzajúca je už vyriešená — presne #269's zámerné správanie).
    const open = await upsertUpozornenie(db, { type: "vratenie", source: "appka", title: "Nová vlna", dedupKey, now: new Date("2026-08-06T12:00:00Z") });
    expect(open.id).not.toBe(resolved.id);

    const result = await returnUpozornenieToOpen(db, { id: resolved.id });
    expect(result).toBe("collision");

    // Staršia karta ostáva vyriešená — pokus o vrátenie NEZANECHAL rozbitý stav.
    const [resolvedRow] = await db.select().from(upozornenie).where(eq(upozornenie.id, resolved.id));
    expect(resolvedRow?.resolvedAt).not.toBeNull();
    const [openRow] = await db.select().from(upozornenie).where(eq(upozornenie.id, open.id));
    expect(openRow?.resolvedAt).toBeNull();
  });

  it("vrátenie VLASTNEJ poznámky (dedupKey null) nikdy nekoliduje — NULL sa nikdy nepovažuje za zhodu", async () => {
    const { db, userId } = await bootDb();
    const now = new Date("2026-08-06T08:00:00Z");
    const a = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Poznámka A", now });
    const b = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Poznámka B", now });
    await resolveUpozornenie(db, { id: a.id, resolvedByUserId: userId, now });
    await resolveUpozornenie(db, { id: b.id, resolvedByUserId: userId, now });

    expect(await returnUpozornenieToOpen(db, { id: a.id })).toBe("returned");
    expect(await returnUpozornenieToOpen(db, { id: b.id })).toBe("returned");
  });
});
