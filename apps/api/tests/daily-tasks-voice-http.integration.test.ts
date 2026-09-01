import { afterEach, expect, it, vi } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { TranscribeClient } from "../src/modules/daily-tasks/transcribe-client.js";
import { VOICE_MAX_AUDIO_BYTES, VOICE_NOTE_PLACEHOLDER } from "../src/modules/daily-tasks/voice.js";
import { withCleanDb } from "./helpers/db.js";

// issue 519: "Hlasová poznámka do úloh" — nahranie (multipart) → prepis (Whisper,
// vstrekovaný klient) alebo audio-only fallback → streamovanie → mazanie
// nahrávky. Klient prepisu je VŽDY falošný (NIKDY skutočné OpenAI).
const HESLO = "test-heslo-voice";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(transcribeClient?: TranscribeClient) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "voice@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Voice", role: "manazer" });
  const app = createApp(ctx.db, { cookieSecure: false, ...(transcribeClient === undefined ? {} : { dailyTasks: { transcribeClient } }) });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "voice@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie };
}

function audioForm(bytes: number, mime: string, durationMs?: string): FormData {
  const form = new FormData();
  form.append("audio", new Blob([Buffer.alloc(bytes, 7)], { type: mime }), `voice.${mime.includes("mp4") ? "m4a" : "webm"}`);
  if (durationMs !== undefined) form.append("durationMs", durationMs);
  return form;
}

async function postVoice(app: ReturnType<typeof createApp>, cookie: string, form: FormData): Promise<Response> {
  return app.request("/api/daily-tasks/voice", { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" }, body: form });
}

interface ListRow {
  readonly id: string;
  readonly text: string;
  readonly hasAudio: boolean;
  readonly audioDurationMs: number | null;
}
async function listRows(app: ReturnType<typeof createApp>, cookie: string): Promise<readonly ListRow[]> {
  const res = await app.request("/api/daily-tasks", { headers: { cookie } });
  const body = (await res.json()) as { rows: ListRow[] };
  return body.rows;
}

it("prepíše nahrávku a uloží audio + prepis ako text úlohy", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("Zavolať Novákovi ohľadom sáčkov");
  const { app, cookie } = await boot(transcribe);

  const res = await postVoice(app, cookie, audioForm(2048, "audio/webm;codecs=opus", "5200"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; id: string; text: string };
  expect(body.ok).toBe(true);
  expect(body.text).toBe("Zavolať Novákovi ohľadom sáčkov");

  // Klient prepisu dostane PLNÉ MIME (vrátane ;codecs) — na base MIME sa oreže
  // až vnútri klienta (Blob type + prípona súboru), nie na trase.
  expect(transcribe).toHaveBeenCalledTimes(1);
  const arg = transcribe.mock.calls[0]?.[0];
  expect(arg?.mime).toBe("audio/webm;codecs=opus");
  expect(arg?.audio.length).toBe(2048);

  const rows = await listRows(app, cookie);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toBe("Zavolať Novákovi ohľadom sáčkov");
  expect(rows[0]?.hasAudio).toBe(true);
  expect(rows[0]?.audioDurationMs).toBe(5200);

  // Streamovanie nahrávky späť.
  const audioRes = await app.request(`/api/daily-tasks/${body.id}/audio`, { headers: { cookie } });
  expect(audioRes.status).toBe(200);
  expect(audioRes.headers.get("content-type")).toBe("audio/webm;codecs=opus");
  expect(audioRes.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await audioRes.arrayBuffer()).length).toBe(2048);
});

it("pri ZLYHANÍ prepisu uloží audio-only so zástupným textom (nikdy nestratí nahrávku)", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockRejectedValue(new Error("OpenAI 500"));
  const { app, cookie } = await boot(transcribe);

  const res = await postVoice(app, cookie, audioForm(2048, "audio/webm", "3000"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { text: string };
  expect(body.text).toBe(VOICE_NOTE_PLACEHOLDER);

  const rows = await listRows(app, cookie);
  expect(rows[0]?.text).toBe(VOICE_NOTE_PLACEHOLDER);
  expect(rows[0]?.hasAudio).toBe(true);
});

it("bez transcribeClient (žiadny OPENAI kľúč) uloží audio-only so zástupným textom", async () => {
  const { app, cookie } = await boot();
  const res = await postVoice(app, cookie, audioForm(2048, "audio/webm"));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { text: string }).text).toBe(VOICE_NOTE_PLACEHOLDER);
  expect((await listRows(app, cookie))[0]?.hasAudio).toBe(true);
});

it("PRÁZDNY prepis (halucinácia na tichu) → zástupný text", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("   \n  ");
  const { app, cookie } = await boot(transcribe);
  const res = await postVoice(app, cookie, audioForm(2048, "audio/webm"));
  expect(((await res.json()) as { text: string }).text).toBe(VOICE_NOTE_PLACEHOLDER);
});

it("odmietne prázdnu/drobnú nahrávku (400) a NIČ neuloží", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("x");
  const { app, cookie } = await boot(transcribe);
  const res = await postVoice(app, cookie, audioForm(512, "audio/webm"));
  expect(res.status).toBe(400);
  expect(transcribe).not.toHaveBeenCalled();
  expect(await listRows(app, cookie)).toHaveLength(0);
});

it("odmietne nepodporovaný formát (400)", async () => {
  const { app, cookie } = await boot();
  const res = await postVoice(app, cookie, audioForm(2048, "audio/aiff"));
  expect(res.status).toBe(400);
  expect(await listRows(app, cookie)).toHaveLength(0);
});

it("odmietne priveľkú nahrávku nad strop (413) a NIČ neuloží", async () => {
  const { app, cookie } = await boot();
  const res = await postVoice(app, cookie, audioForm(VOICE_MAX_AUDIO_BYTES + 1, "audio/webm"));
  expect(res.status).toBe(413);
  expect(await listRows(app, cookie)).toHaveLength(0);
});

it("odmietne cross-site pôvod na POST /voice aj DELETE /audio (403 CSRF)", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("x");
  const { app, cookie } = await boot(transcribe);
  const post = await app.request("/api/daily-tasks/voice", { method: "POST", headers: { cookie, "sec-fetch-site": "cross-site" }, body: audioForm(2048, "audio/webm") });
  expect(post.status).toBe(403);
  expect(transcribe).not.toHaveBeenCalled();

  // Vytvor legitímnu hlasovú úlohu (same-origin) a skús cross-site DELETE audia.
  const id = ((await (await postVoice(app, cookie, audioForm(2048, "audio/webm"))).json()) as { id: string }).id;
  const del = await app.request(`/api/daily-tasks/${id}/audio`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "cross-site" } });
  expect(del.status).toBe(403);
  // Audio ostalo (cross-site DELETE neprešiel).
  expect((await listRows(app, cookie))[0]?.hasAudio).toBe(true);
});

it("nezmyselne veľké durationMs sa uloží ako null (žiadny int4 overflow / 500)", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("y");
  const { app, cookie } = await boot(transcribe);
  const res = await postVoice(app, cookie, audioForm(2048, "audio/webm", "99999999999"));
  expect(res.status).toBe(200);
  expect((await listRows(app, cookie))[0]?.audioDurationMs).toBeNull();
});

it("DELETE /audio zmaže LEN nahrávku, text úlohy ostáva", async () => {
  const transcribe = vi.fn<TranscribeClient>().mockResolvedValue("Poznámka z auta");
  const { app, cookie } = await boot(transcribe);
  const id = ((await (await postVoice(app, cookie, audioForm(2048, "audio/webm", "4000"))).json()) as { id: string }).id;

  const del = await app.request(`/api/daily-tasks/${id}/audio`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "same-origin" } });
  expect(del.status).toBe(200);
  expect(((await del.json()) as { updated: boolean }).updated).toBe(true);

  const rows = await listRows(app, cookie);
  expect(rows[0]?.text).toBe("Poznámka z auta"); // text zostal
  expect(rows[0]?.hasAudio).toBe(false); // nahrávka preč
  expect(rows[0]?.audioDurationMs).toBeNull();

  // Nahrávka sa už nedá stiahnuť.
  const audioRes = await app.request(`/api/daily-tasks/${id}/audio`, { headers: { cookie } });
  expect(audioRes.status).toBe(404);
});

it("GET /audio pre TEXTOVÚ úlohu (bez nahrávky) → 404", async () => {
  const { app, cookie } = await boot();
  const created = await app.request("/api/daily-tasks", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ text: "obyčajná úloha" }),
  });
  const id = ((await created.json()) as { id: string }).id;
  const audioRes = await app.request(`/api/daily-tasks/${id}/audio`, { headers: { cookie } });
  expect(audioRes.status).toBe(404);
});

it("POST /voice bez prihlásenia → 401", async () => {
  const { app } = await boot();
  const res = await app.request("/api/daily-tasks/voice", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: audioForm(2048, "audio/webm") });
  expect(res.status).toBe(401);
});
