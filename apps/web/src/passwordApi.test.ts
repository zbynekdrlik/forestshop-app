import { expect, it, vi } from "vitest";
import { PasswordChangeUnauthorizedError, postChangePassword } from "./passwordApi.js";

it("vráti ok pri úspechu (telo { ok: true })", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
  await expect(postChangePassword("stare", "nove-heslo-123")).resolves.toEqual({ ok: true });
});

it("zlé staré heslo (200, telo { ok: false, error }) vráti chybovú hlášku zo servera", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "Nesprávne staré heslo" }), { status: 200 }),
    ),
  );
  await expect(postChangePassword("zle", "nove-heslo-123")).resolves.toEqual({
    ok: false,
    error: "Nesprávne staré heslo",
  });
});

it("pri nerozpoznateľnom tvare tela vráti všeobecnú hlášku", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 400 })));
  await expect(postChangePassword("zle", "krat")).resolves.toEqual({
    ok: false,
    error: "Zmena hesla zlyhala",
  });
});

it("pri 401 vyhodí PasswordChangeUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(postChangePassword("stare", "nove-heslo-123")).rejects.toBeInstanceOf(
    PasswordChangeUnauthorizedError,
  );
});
