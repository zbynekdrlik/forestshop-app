import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { SCAN_MAX_IMAGE_BYTES } from "../src/modules/uhrady/image.js";
import { withCleanDb } from "./helpers/db.js";

// issue 543: "SLAVOSPORT → Úhrady" — zdieľané jednoriadkové poznámky + upload
// naskenovaných FA (thumbnaily s popisom). Rovnako ako `note`/`daily-tasks`
// STAČÍ `requireUser` na KAŽDÚ akciu (žiadny `requireRole`); autor sa ukladá
// zo session, ostatné akcie vlastníctvo nevynucujú.
const HESLO = "test-heslo-uhrady";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole = "sef") {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "uhrady@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Úhrady", role });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "uhrady@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);

// Postaví buffer PRESNEJ dĺžky `bytes` so správnou signatúrou pre `mime`
// (route od tejto zmeny overuje magické bajty). Nepodporované mime dostane
// surové bajty — signatúrny check ich aj tak nikdy nedosiahne (mime/veľkosť
// zlyhá skôr).
function imageBytes(bytes: number, mime: string): Buffer {
  const base = mime.toLowerCase();
  const sig = base.includes("png") ? PNG_SIG : base.includes("jpeg") || base.includes("jpg") ? JPEG_SIG : Buffer.alloc(0);
  if (sig.length === 0 || bytes <= sig.length) return Buffer.alloc(bytes, 9);
  return Buffer.concat([sig, Buffer.alloc(bytes - sig.length, 9)]);
}

function imageForm(bytes: number, mime: string, description?: string): FormData {
  const form = new FormData();
  const ext = mime.includes("png") ? "png" : "jpg";
  form.append("image", new Blob([imageBytes(bytes, mime)], { type: mime }), `fa.${ext}`);
  if (description !== undefined) form.append("description", description);
  return form;
}

// Platný mime + platná veľkosť, ale NEPLATNÁ signatúra (podvrhnutý obsah).
function fakeSignatureForm(bytes: number, mime: string): FormData {
  const form = new FormData();
  form.append("image", new Blob([Buffer.alloc(bytes, 9)], { type: mime }), "fa.png");
  return form;
}

async function postScan(app: ReturnType<typeof createApp>, cookie: string, form: FormData): Promise<Response> {
  return app.request("/api/uhrady/scans", { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" }, body: form });
}

interface ScanRow {
  readonly id: string;
  readonly description: string;
  readonly authorName: string;
}
async function listScans(app: ReturnType<typeof createApp>, cookie: string): Promise<readonly (ScanRow & { image?: unknown })[]> {
  const res = await app.request("/api/uhrady/scans", { headers: { cookie } });
  const body = (await res.json()) as { rows: (ScanRow & { image?: unknown })[] };
  return body.rows;
}

// --- Poznámky ---
describe("Úhrady — poznámky", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot();
    const res = await app.request("/api/uhrady/notes");
    expect(res.status).toBe(401);
  });

  it("čerstvá DB má prázdny zoznam", async () => {
    const { app, cookie } = await boot();
    const res = await app.request("/api/uhrady/notes", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: unknown[] }).rows).toEqual([]);
  });

  it("pridá, zoradí najnovšie hore s autorom a zmaže", async () => {
    const { app, cookie } = await boot();
    await app.request("/api/uhrady/notes", { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "uhradiť Fomei FA" }) });
    await app.request("/api/uhrady/notes", { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "zavolať do banky" }) });

    const res = await app.request("/api/uhrady/notes", { headers: { cookie } });
    const rows = ((await res.json()) as { rows: { id: string; text: string; authorName: string }[] }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe("zavolať do banky"); // najnovšia hore
    expect(rows[1]?.text).toBe("uhradiť Fomei FA");
    expect(rows[0]?.authorName).toBe("Úhrady");

    const del = await app.request(`/api/uhrady/notes/${String(rows[0]?.id)}`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { removed: boolean }).removed).toBe(true);
    const after = ((await (await app.request("/api/uhrady/notes", { headers: { cookie } })).json()) as { rows: unknown[] }).rows;
    expect(after).toHaveLength(1);
  });

  it("odmietne prázdny text (400) a cross-site pôvod (403)", async () => {
    const { app, cookie } = await boot();
    const empty = await app.request("/api/uhrady/notes", { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "  " }) });
    expect(empty.status).toBe(400);
    const cross = await app.request("/api/uhrady/notes", { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ text: "x" }) });
    expect(cross.status).toBe(403);
  });
});

// --- Skeny FA ---
describe("Úhrady — skeny FA", () => {
  it("nahrá obrázok, zoznam NEnesie bajty, a streamuje originál späť", async () => {
    const { app, cookie } = await boot();
    const res = await postScan(app, cookie, imageForm(4096, "image/png", "Fomei 250 €"));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const rows = await listScans(app, cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Fomei 250 €");
    expect(rows[0]?.authorName).toBe("Úhrady");
    // `image` (bytea) sa NIKDY nevracia v zozname (inak by sa poll nafúkol).
    expect(rows[0]?.image).toBeUndefined();

    const img = await app.request(`/api/uhrady/scans/${id}/image`, { headers: { cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await img.arrayBuffer()).length).toBe(4096);
  });

  it("uloží popis aj bez zadania (default prázdny) a upraví ho cez PATCH", async () => {
    const { app, cookie } = await boot();
    const id = ((await (await postScan(app, cookie, imageForm(2048, "image/jpeg"))).json()) as { id: string }).id;
    expect((await listScans(app, cookie))[0]?.description).toBe("");

    const patch = await app.request(`/api/uhrady/scans/${id}/description`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ description: "Metalov FA 128,40 €" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { updated: boolean }).updated).toBe(true);
    expect((await listScans(app, cookie))[0]?.description).toBe("Metalov FA 128,40 €");
  });

  it("zmaže sken (po úhrade) — zoznam je prázdny a obrázok už nie je dostupný", async () => {
    const { app, cookie } = await boot();
    const id = ((await (await postScan(app, cookie, imageForm(2048, "image/png"))).json()) as { id: string }).id;
    const del = await app.request(`/api/uhrady/scans/${id}`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { removed: boolean }).removed).toBe(true);
    expect(await listScans(app, cookie)).toHaveLength(0);
    const img = await app.request(`/api/uhrady/scans/${id}/image`, { headers: { cookie } });
    expect(img.status).toBe(404);
  });

  it("odmietne nepodporovaný formát (400), prázdny (400), priveľký (413), podvrhnutú signatúru (400) a NIČ neuloží", async () => {
    const { app, cookie } = await boot();
    expect((await postScan(app, cookie, imageForm(4096, "application/pdf"))).status).toBe(400);
    expect((await postScan(app, cookie, imageForm(16, "image/png"))).status).toBe(400);
    expect((await postScan(app, cookie, imageForm(SCAN_MAX_IMAGE_BYTES + 1, "image/png"))).status).toBe(413);
    // Platný mime + veľkosť, ale bajty nie sú PNG/JPEG → 400 (magic-byte check).
    expect((await postScan(app, cookie, fakeSignatureForm(4096, "image/png"))).status).toBe(400);
    expect(await listScans(app, cookie)).toHaveLength(0);
  });

  it("odmietne chýbajúci súbor (400) a cross-site upload/patch/delete (403 CSRF)", async () => {
    const { app, cookie } = await boot();
    const missing = await app.request("/api/uhrady/scans", { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" }, body: new FormData() });
    expect(missing.status).toBe(400);

    const cross = await app.request("/api/uhrady/scans", { method: "POST", headers: { cookie, "sec-fetch-site": "cross-site" }, body: imageForm(2048, "image/png") });
    expect(cross.status).toBe(403);

    const id = ((await (await postScan(app, cookie, imageForm(2048, "image/png"))).json()) as { id: string }).id;
    const crossPatch = await app.request(`/api/uhrady/scans/${id}/description`, { method: "PATCH", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ description: "x" }) });
    expect(crossPatch.status).toBe(403);
    const crossDel = await app.request(`/api/uhrady/scans/${id}`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "cross-site" } });
    expect(crossDel.status).toBe(403);
    // Sken ostal (cross-site zápisy neprešli).
    expect(await listScans(app, cookie)).toHaveLength(1);
  });

  it("GET image bez prihlásenia → 401; neexistujúci sken → 404", async () => {
    const { app, cookie } = await boot();
    const id = ((await (await postScan(app, cookie, imageForm(2048, "image/png"))).json()) as { id: string }).id;
    const noAuth = await app.request(`/api/uhrady/scans/${id}/image`);
    expect(noAuth.status).toBe(401);
    const missing = await app.request(`/api/uhrady/scans/11111111-1111-1111-1111-111111111111/image`, { headers: { cookie } });
    expect(missing.status).toBe(404);
  });

  it("zdieľané — druhý používateľ vidí a smie zmazať cudzí sken", async () => {
    const { app, cookie, db } = await boot();
    const id = ((await (await postScan(app, cookie, imageForm(2048, "image/png", "moja FA"))).json()) as { id: string }).id;

    // Druhý používateľ v tej istej (už čistej) DB — len ďalší login.
    await db.insert(users).values({ email: "druhy@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Druhý", role: "citanie" });
    const login2 = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "druhy@forestshop.sk", password: HESLO }) });
    const cookie2 = (login2.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    expect(await listScans(app, cookie2)).toHaveLength(1); // vidí cudzí sken
    const del = await app.request(`/api/uhrady/scans/${id}`, { method: "DELETE", headers: { cookie: cookie2, "sec-fetch-site": "same-origin" } });
    expect(((await del.json()) as { removed: boolean }).removed).toBe(true); // smie zmazať
    expect(await listScans(app, cookie)).toHaveLength(0);
  });
});
