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

it("vráti null pri stave 401", async () => {
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
