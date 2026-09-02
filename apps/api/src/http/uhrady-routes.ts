import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { getPaymentScanImage, listPaymentNotes, listPaymentScans } from "../modules/uhrady/queries.js";
import { baseImageMime, isAllowedImageMime, looksLikeJpegOrPng, SCAN_DESCRIPTION_MAX_CHARS, SCAN_MAX_IMAGE_BYTES, SCAN_MIN_IMAGE_BYTES } from "../modules/uhrady/image.js";
import {
  createPaymentNote,
  createPaymentScan,
  deletePaymentNote,
  deletePaymentScan,
  updatePaymentScanDescription,
} from "../modules/uhrady/service.js";
import { requireSameOrigin } from "./origin-check.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 543: "SLAVOSPORT → Úhrady". ZDIEĽANÝ tímový nástroj — na KAŽDÚ akciu
// STAČÍ `requireUser` (žiadny `requireRole`, ako `note`/`daily-tasks`); autor
// sa ukladá zo session pri create a zobrazuje pri riadku, ostatné akcie
// vlastníctvo ZÁMERNE nevynucujú.
const createNoteBody = z.object({ text: z.string().trim().min(1).max(300) });
const descriptionBody = z.object({ description: z.string().trim().max(SCAN_DESCRIPTION_MAX_CHARS) });
const idParam = z.object({ id: z.string().uuid() });

export function registerUhradyRoutes(app: Hono<AppBindings>, db: Database): void {
  // --- Jednoriadkové poznámky navrchu ---
  app.get("/api/uhrady/notes", requireUser(db), async (c) => {
    const rows = await listPaymentNotes(db);
    return c.json({ rows });
  });

  app.post("/api/uhrady/notes", requireSameOrigin(), requireUser(db), zValidator("json", createNoteBody), async (c) => {
    const { text } = c.req.valid("json");
    const user = c.get("user");
    const created = await createPaymentNote(db, { userId: user.userId, text, now: new Date() });
    return c.json({ ok: true as const, id: created.id });
  });

  app.delete("/api/uhrady/notes/:id", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deletePaymentNote(db, { id });
    return c.json({ ok: true as const, removed });
  });

  // --- Naskenované FA (thumbnaily) ---
  app.get("/api/uhrady/scans", requireUser(db), async (c) => {
    const rows = await listPaymentScans(db);
    return c.json({ rows });
  });

  // Nahranie skenu (multipart: `image` súbor + voliteľný `description`).
  // `bodyLimit` odmietne priveľké telo PRED bufferovaním (Content-Length aj
  // počas čítania). `image` (bytea) sa NIKDY nevracia v zozname — streamuje sa
  // trasou `/:id/image` nižšie.
  app.post(
    "/api/uhrady/scans",
    requireSameOrigin(),
    requireUser(db),
    bodyLimit({
      maxSize: SCAN_MAX_IMAGE_BYTES + 64 * 1024, // rezerva na multipart hlavičky/hranice
      onError: (c) => c.json({ error: "Obrázok je priveľký." }, 413),
    }),
    async (c) => {
      const user = c.get("user");
      const form = await c.req.parseBody();
      const file = form["image"];
      if (!(file instanceof File)) {
        return c.json({ error: "Chýba obrázok." }, 400);
      }
      const mime = file.type;
      if (!isAllowedImageMime(mime)) {
        return c.json({ error: "Nepodporovaný formát — nahraj JPG alebo PNG." }, 400);
      }
      const image = Buffer.from(await file.arrayBuffer());
      if (image.length < SCAN_MIN_IMAGE_BYTES) {
        return c.json({ error: "Obrázok je prázdny alebo príliš malý." }, 400);
      }
      if (image.length > SCAN_MAX_IMAGE_BYTES) {
        return c.json({ error: "Obrázok je priveľký." }, 413);
      }
      // Signatúra súboru musí sedieť (MIME je od klienta) — bránime nahratiu
      // HTML/skriptu s podvrhnutým `image/*` typom.
      if (!looksLikeJpegOrPng(image)) {
        return c.json({ error: "Súbor nie je platný JPG ani PNG obrázok." }, 400);
      }

      const rawDescription = form["description"];
      const description = typeof rawDescription === "string" ? rawDescription.trim().slice(0, SCAN_DESCRIPTION_MAX_CHARS) : "";

      // Ulož KANONICKÉ base MIME (bez prípadného `;parametra`, malé písmená) —
      // tá istá hodnota sa neskôr servíruje ako `Content-Type`.
      const created = await createPaymentScan(db, { userId: user.userId, image, imageMime: baseImageMime(mime), description, now: new Date() });
      return c.json({ ok: true as const, id: created.id });
    },
  );

  // Streamovanie originálu (grid ho zmenší cez CSS, lightbox ukáže plnú
  // veľkosť). `nosniff` — MIME je od klienta, bránime "HTML nahraté ako
  // image/png" sniffing vektoru. 404, keď sken neexistuje.
  app.get("/api/uhrady/scans/:id/image", requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const found = await getPaymentScanImage(db, id);
    if (found === null) return c.json({ error: "Sken nenájdený." }, 404);
    return new Response(found.image, {
      status: 200,
      headers: {
        "Content-Type": found.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  app.patch("/api/uhrady/scans/:id/description", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", descriptionBody), async (c) => {
    const { id } = c.req.valid("param");
    const { description } = c.req.valid("json");
    const updated = await updatePaymentScanDescription(db, { id, description, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.delete("/api/uhrady/scans/:id", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deletePaymentScan(db, { id });
    return c.json({ ok: true as const, removed });
  });
}
