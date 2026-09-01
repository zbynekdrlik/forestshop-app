import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { createDailyTask, createVoiceDailyTask, deleteDailyTask, deleteDailyTaskAudio, setDailyTaskDone, updateDailyTaskEmoji, updateDailyTaskText } from "../modules/daily-tasks/service.js";
import { countOpenDailyTasks, getDailyTaskAudio, listDailyTasks } from "../modules/daily-tasks/queries.js";
import type { TranscribeClient } from "../modules/daily-tasks/transcribe-client.js";
import { audioExtensionForMime, VOICE_MAX_AUDIO_BYTES, VOICE_MIN_AUDIO_BYTES, voiceTaskText } from "../modules/daily-tasks/voice.js";
import { requireSameOrigin } from "./origin-check.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 342 + 487: "Úlohy na dnes". Pôvodne súkromný per-používateľský zoznam
// (#342); od #487 ZDIEĽANÝ — každý prihlásený účet vidí a smie odfajknúť/upraviť/
// zmazať VŠETKY úlohy (presne ako Poznámky `note`, #437). Na KAŽDÚ akciu vrátane
// zápisu STAČÍ `requireUser` (žiadny `requireRole`) — je to zdieľaný tímový
// nástroj a aj rola "citanie" musí vedieť pridávať/spracúvať. Autor sa PRI
// VYTVORENÍ ukladá zo session (`user.userId`) a zobrazuje sa pri riadku; ostatné
// akcie vlastníctvo ZÁMERNE nevynucujú (server ho nekľúčuje, `service.ts`).
const createBody = z.object({ text: z.string().trim().min(1).max(300) });
const updateTextBody = z.object({ text: z.string().trim().min(1).max(300) });
// Code review: 16 znakov by odmietlo legitímnu VIACPRVKOVÚ emoji sekvenciu
// (rodinné/kožný odtieň kombinácie spájané ZWJ znakom môžu ľahko presiahnuť
// 16 UTF-16 jednotiek) — 32 dáva dosť priestoru aj pre takú sekvenciu a stále
// bráni zjavnému zneužitiu poľa na dlhý text.
const updateEmojiBody = z.object({ emoji: z.string().trim().max(32).nullable() });
const doneBody = z.object({ done: z.boolean() });
const idParam = z.object({ id: z.string().uuid() });

// issue 519: "Hlasová poznámka" — vstrekovaný prepisový klient (Whisper).
// `transcribeClient` chýba (testy/lokálny vývoj bez `OPENAI_API_KEY`) = poznámka
// sa uloží audio-only (nikdy sa nestratí nahrávka). `index.ts` v produkcii dodá
// reálny klient LEN keď je `OPENAI_API_KEY` nastavený.
export interface DailyTasksRunDeps {
  readonly transcribeClient?: TranscribeClient;
}

export function registerDailyTasksRoutes(app: Hono<AppBindings>, db: Database, deps: DailyTasksRunDeps = {}): void {
  app.get("/api/daily-tasks", requireUser(db), async (c) => {
    const rows = await listDailyTasks(db);
    return c.json({ rows });
  });

  // issue 473 + 487: odznak počtu v ľavom menu — počet OTVORENÝCH (bez fajky)
  // úloh VŠETKÝCH účtov (zdieľaný zoznam). Literal-path súrodenec MUSÍ byť pred
  // `/:id` trasami rovnakej metódy (`.claude/rules/http-routes.md` — poradie
  // literal-vs-`:param`); dnes žiadna GET `/:id` trasa neexistuje, ale poradie sa
  // drží ako zvyk (rovnako ako `upozornenia-routes.ts`'s `/count`).
  app.get("/api/daily-tasks/count", requireUser(db), async (c) => {
    const count = await countOpenDailyTasks(db);
    return c.json({ count });
  });

  app.post("/api/daily-tasks", requireSameOrigin(), requireUser(db), zValidator("json", createBody), async (c) => {
    const { text } = c.req.valid("json");
    const user = c.get("user");
    const created = await createDailyTask(db, { userId: user.userId, text, now: new Date() });
    return c.json({ ok: true as const, id: created.id });
  });

  // issue 519: nahranie hlasovej poznámky (multipart: `audio` súbor +
  // voliteľné `durationMs`). `bodyLimit` odmietne priveľké telo PRED
  // bufferovaním (Content-Length aj počas čítania). Literal-path `/voice` je
  // pred `/:id/...` trasami (poradie ako `/count` vyššie).
  app.post(
    "/api/daily-tasks/voice",
    requireSameOrigin(),
    requireUser(db),
    bodyLimit({
      maxSize: VOICE_MAX_AUDIO_BYTES + 64 * 1024, // rezerva na multipart hlavičky/hranice
      onError: (c) => c.json({ error: "Nahrávka je priveľká." }, 413),
    }),
    async (c) => {
      const user = c.get("user");
      const form = await c.req.parseBody();
      const file = form["audio"];
      if (!(file instanceof File)) {
        return c.json({ error: "Chýba nahrávka." }, 400);
      }
      const mime = file.type;
      if (audioExtensionForMime(mime) === null) {
        return c.json({ error: "Nepodporovaný formát nahrávky." }, 400);
      }
      const audio = Buffer.from(await file.arrayBuffer());
      if (audio.length < VOICE_MIN_AUDIO_BYTES) {
        return c.json({ error: "Nahrávka je prázdna alebo príliš krátka." }, 400);
      }
      if (audio.length > VOICE_MAX_AUDIO_BYTES) {
        return c.json({ error: "Nahrávka je priveľká." }, 413);
      }

      // Dĺžka z KLIENTSKEHO časovača (`<audio>` pri webm hlási `Infinity`).
      // Nepovinná, tolerantne parsovaná; nezmyselná hodnota → `null`.
      const rawDuration = form["durationMs"];
      let audioDurationMs: number | null = null;
      if (typeof rawDuration === "string") {
        const parsed = Number.parseInt(rawDuration, 10);
        // Strop 24 h — stĺpec je `integer` (int4); väčšia hodnota by pretiekla a
        // zhodila insert na 500. Nezmyselná/priveľká hodnota → `null`.
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 86_400_000) audioDurationMs = parsed;
      }

      // Prepis je SYNCHRÓNNY (šéf pozrie na telefón, spinner 1–3 s), s
      // časovým stropom v samotnom klientovi. AKÉKOĽVEK zlyhanie (bez kľúča →
      // klient chýba; sieť/ne-2xx/timeout/prázdny prepis) → zástupný text,
      // audio-only — nahrávka sa VŽDY uloží.
      let transcript: string | null = null;
      if (deps.transcribeClient !== undefined) {
        try {
          transcript = await deps.transcribeClient({ audio, mime });
        } catch (err: unknown) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "prepis hlasovej poznámky zlyhal — ukladám audio-only");
          transcript = null;
        }
      }
      const text = voiceTaskText(transcript);

      const created = await createVoiceDailyTask(db, {
        userId: user.userId,
        text,
        audio,
        audioMime: mime,
        audioDurationMs,
        now: new Date(),
      });
      return c.json({ ok: true as const, id: created.id, text });
    },
  );

  // issue 519: streamovanie nahrávky. `nosniff` — MIME je od klienta, bránime
  // "HTML nahraté ako audio/webm" sniffing vektoru. 404, keď úloha nemá audio.
  app.get("/api/daily-tasks/:id/audio", requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const found = await getDailyTaskAudio(db, id);
    if (found === null) return c.json({ error: "Nahrávka nenájdená." }, 404);
    // `Buffer` je platný `BodyInit`; `new Response` sa typuje čisto (Hono
    // handler smie vrátiť aj surový `Response`). `nosniff` — MIME je od klienta.
    return new Response(found.audio, {
      status: 200,
      headers: {
        "Content-Type": found.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  app.patch("/api/daily-tasks/:id/text", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", updateTextBody), async (c) => {
    const { id } = c.req.valid("param");
    const { text } = c.req.valid("json");
    const updated = await updateDailyTaskText(db, { id, text, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.patch("/api/daily-tasks/:id/emoji", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", updateEmojiBody), async (c) => {
    const { id } = c.req.valid("param");
    const { emoji } = c.req.valid("json");
    const updated = await updateDailyTaskEmoji(db, { id, emoji: emoji === "" ? null : emoji, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.post("/api/daily-tasks/:id/done", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", doneBody), async (c) => {
    const { id } = c.req.valid("param");
    const { done } = c.req.valid("json");
    const updated = await setDailyTaskDone(db, { id, done, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  // issue 519: „potom sa dá odkaz vymazať" — zmaže LEN nahrávku, úlohu nechá.
  app.delete("/api/daily-tasks/:id/audio", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const updated = await deleteDailyTaskAudio(db, { id, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.delete("/api/daily-tasks/:id", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deleteDailyTask(db, { id });
    return c.json({ ok: true as const, removed });
  });
}
