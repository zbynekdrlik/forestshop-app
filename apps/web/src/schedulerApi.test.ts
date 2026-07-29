import { expect, it, vi } from "vitest";
import { SchedulerUnauthorizedError, fetchJobRuns } from "./schedulerApi.js";

const RUN = {
  jobName: "prune-raw-exports",
  startedAt: "2026-07-29T01:15:00.000Z",
  finishedAt: "2026-07-29T01:15:02.000Z",
  status: "success" as const,
  detail: { removed: 3 },
  errorMessage: null,
};

it("prečíta zoznam behov úloh", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [RUN] }), { status: 200 })),
  );
  await expect(fetchJobRuns()).resolves.toEqual([RUN]);
});

it("odmietne odpoveď s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ jobName: 1 }] }), { status: 200 })),
  );
  await expect(fetchJobRuns()).rejects.toThrow();
});

it("pri 401 vyhodí SchedulerUnauthorizedError namiesto všeobecnej chyby", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(fetchJobRuns()).rejects.toBeInstanceOf(SchedulerUnauthorizedError);
});

it("zlyhá zrozumiteľne pri chybe servera", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(fetchJobRuns()).rejects.toThrow("Prehľad plánovača sa nepodarilo načítať");
});
