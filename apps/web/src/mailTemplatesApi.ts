import { z } from "zod";

// issue 192: obrazovka "Texty e-mailov" — zrkadlí `http/mail-template-routes.ts`.

const placeholderSchema = z.object({ name: z.string(), label: z.string() });
export type MailPlaceholder = z.infer<typeof placeholderSchema>;

const templateSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  subject: z.string(),
  body: z.string(),
  defaultSubject: z.string(),
  defaultBody: z.string(),
  isCustomized: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByName: z.string().nullable(),
  placeholders: z.array(placeholderSchema),
});
export type MailTemplate = z.infer<typeof templateSchema>;

const listSchema = z.object({ templates: z.array(templateSchema) });

const previewSchema = z.union([
  z.object({ ok: z.literal(true), subject: z.string(), html: z.string(), text: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type MailTemplatePreview = z.infer<typeof previewSchema>;

const writeSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);
export type MailTemplateWriteResult = z.infer<typeof writeSchema>;

const historyEntrySchema = z.object({
  id: z.string(),
  action: z.enum(["save", "reset"]),
  subject: z.string(),
  changedAt: z.string(),
  changedByName: z.string().nullable(),
});
export type MailTemplateHistoryEntry = z.infer<typeof historyEntrySchema>;

const historySchema = z.union([
  z.object({ ok: z.literal(true), entries: z.array(historyEntrySchema) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export class MailTemplatesUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

const errorBodySchema = z.object({ error: z.string() });

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new MailTemplatesUnauthorizedError();
  if (!response.ok) {
    try {
      const parsed = errorBodySchema.safeParse(await response.json());
      if (parsed.success) throw new Error(parsed.data.error);
    } catch (error) {
      if (error instanceof Error && error.message !== "") throw error;
    }
    throw new Error(fallback);
  }
  return await response.json();
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function fetchMailTemplates(): Promise<readonly MailTemplate[]> {
  const response = await fetch("/api/mail-templates");
  return listSchema.parse(await readJson(response, "Texty e-mailov sa nepodarilo načítať")).templates;
}

export async function fetchMailTemplatePreview(key: string, subject: string, body: string): Promise<MailTemplatePreview> {
  const response = await fetch("/api/mail-templates/preview", jsonInit("POST", { key, subject, body }));
  return previewSchema.parse(await readJson(response, "Náhľad sa nepodarilo pripraviť"));
}

export async function saveMailTemplate(key: string, subject: string, body: string): Promise<MailTemplateWriteResult> {
  const response = await fetch(`/api/mail-templates/${encodeURIComponent(key)}`, jsonInit("PUT", { subject, body }));
  return writeSchema.parse(await readJson(response, "Uloženie zlyhalo"));
}

export async function resetMailTemplate(key: string): Promise<MailTemplateWriteResult> {
  const response = await fetch(`/api/mail-templates/${encodeURIComponent(key)}/reset`, jsonInit("POST"));
  return writeSchema.parse(await readJson(response, "Vrátenie pôvodného znenia zlyhalo"));
}

export async function fetchMailTemplateHistory(key: string): Promise<readonly MailTemplateHistoryEntry[]> {
  const response = await fetch(`/api/mail-templates/${encodeURIComponent(key)}/history`);
  const parsed = historySchema.parse(await readJson(response, "Históriu zmien sa nepodarilo načítať"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.entries;
}
