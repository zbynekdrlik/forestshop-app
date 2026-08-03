import { expect, it, vi } from "vitest";
import { fetchMe } from "./api.js";

it("vráti používateľa pri stave 200", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ userId: "1", email: "a@b.sk", displayName: "A", role: "admin" }), {
        status: 200,
      }),
    ),
  );
  await expect(fetchMe()).resolves.toMatchObject({ role: "admin" });
});

// issue 188: neprihlásený dostane 200 s telom `null` — 401 by prehliadač
// zalogoval do konzoly ako červenú chybu na prihlasovacej obrazovke.
it("vráti null pri stave 200 s telom null (neprihlásený)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
  await expect(fetchMe()).resolves.toBeNull();
});

// Starý server proti novému frontendu počas nasadenia — 401 stále znamená
// "neprihlásený", nie pád.
it("vráti null aj pri stave 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(fetchMe()).resolves.toBeNull();
});

it("odmietne odpoveď s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: 42 }), { status: 200 })),
  );
  await expect(fetchMe()).rejects.toThrow();
});
