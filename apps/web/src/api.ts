import { z } from "zod";

const meSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["admin", "manazer", "sef", "citanie"]),
});

const versionSchema = z.object({ version: z.string(), commit: z.string() });

export type Me = z.infer<typeof meSchema>;

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  // issue 188: neprihlásený dostane 200 s telom `null` (nie 401), aby
  // prehliadač nelogoval červenú chybu na prihlasovacej obrazovke. 401 sa
  // tu stále ošetruje pre istotu — počas nasadenia môže krátko bežať starý
  // server proti novému frontendu.
  if (res.status === 401) return null;
  const body: unknown = await res.json();
  if (body === null) return null;
  return meSchema.parse(body);
}

export async function fetchVersion(): Promise<z.infer<typeof versionSchema>> {
  return versionSchema.parse(await (await fetch("/api/version")).json());
}

export async function postLogin(email: string, password: string): Promise<boolean> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.ok;
}

export async function postLogout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}
