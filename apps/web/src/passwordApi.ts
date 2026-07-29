/** Relácia medzitým vypršala (401) — rovnaký rozdiel ako `CatalogUnauthorizedError`/`SchedulerUnauthorizedError`. */
export class PasswordChangeUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

export type ChangePasswordResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function postChangePassword(
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const res = await fetch("/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oldPassword, newPassword }),
  });
  if (res.status === 401) throw new PasswordChangeUnauthorizedError();
  // Server posiela `{ ok: true }` alebo `{ ok: false, error: "..." }` — vždy s
  // 200 (aj pre "zlé staré heslo", zámerne, pozri komentár pri trase v
  // `http/app.ts`). Iný tvar tela (napr. zod validačná chyba pri obídení
  // klientskej kontroly dĺžky, alebo CSRF 403) padne na všeobecnú hlášku —
  // nikdy sa nezobrazí surová/technická chybová štruktúra používateľovi.
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === "object" && body !== null && "ok" in body) {
    if (body.ok === true) return { ok: true };
    const error = "error" in body && typeof body.error === "string" ? body.error : "Zmena hesla zlyhala";
    return { ok: false, error };
  }
  return { ok: false, error: "Zmena hesla zlyhala" };
}
