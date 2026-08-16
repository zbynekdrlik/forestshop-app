import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { withCleanDb } from "./helpers/db.js";

// issue 440: emoji sa v appke MUSIA uložiť aj vrátiť identicky (Postgres `text`
// + node-postgres nesú 4-bajtové UTF-8; žiadna sanitizácia). Šéfovo „nefunguje"
// bolo o CHÝBAJÚCOM spôsobe vloženia (picker), nie o perzistencii — tento test
// ZAMKNE perzistenciu, aby ju budúca sanitizácia nemohla ticho pokaziť. Vzorka
// pokrýva viac-codepointové emoji: ZWJ rodinu, regionálnu vlajku, variation
// selector.
const HESLO = "test-heslo-abc";
const EMOJI = "test 👍🙂 ✅❤️ 🌲 👨‍👩‍👧‍👦 🇸🇰";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function bootAdmin() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "sef@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Šéf 🙂", role: "admin" });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sef@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie };
}

describe("emoji perzistencia (issue 440)", () => {
  it("Poznámka: emoji sa uloží a vráti IDENTICKY (POST /api/notes → GET /api/notes)", async () => {
    const { app, cookie } = await bootAdmin();
    const create = await app.request("/api/notes", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: EMOJI }),
    });
    expect(create.status).toBe(200);

    const list = await app.request("/api/notes", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { body: string }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.body).toBe(EMOJI);
  });

  it("Upozornenie: emoji v nadpise aj podrobnostiach sa uloží a vráti IDENTICKY (POST → GET /api/upozornenia)", async () => {
    const { app, cookie } = await bootAdmin();
    const create = await app.request("/api/upozornenia", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: `Nadpis ${EMOJI}`, details: `Detaily ${EMOJI}` }),
    });
    expect(create.status).toBe(200);

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { title: string; details: string }[] };
    const row = body.rows.find((r) => r.title.startsWith("Nadpis "));
    expect(row?.title).toBe(`Nadpis ${EMOJI}`);
    expect(row?.details).toBe(`Detaily ${EMOJI}`);
  });
});
