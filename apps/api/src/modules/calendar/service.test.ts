import { describe, expect, it, vi } from "vitest";
import { createNextEventService } from "./service.js";
import { NEXT_EVENT_ERROR_CACHE_TTL_MS, NEXT_EVENT_OK_CACHE_TTL_MS } from "./constants.js";

const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join("\r\n");
const NOW = new Date("2026-08-08T10:00:00Z");

describe("createNextEventService — cache", () => {
  it("druhé volanie v TTL okne NEVOLÁ fetchIcs znova (cache hit)", async () => {
    const fetchIcs = vi.fn().mockResolvedValue(ICS);
    const service = createNextEventService([fetchIcs]);
    await service.getNextEvent(NOW);
    await service.getNextEvent(new Date(NOW.getTime() + 1000));
    expect(fetchIcs).toHaveBeenCalledTimes(1);
  });

  it("volanie PO uplynutí úspešnej TTL znova zavolá fetchIcs", async () => {
    const fetchIcs = vi.fn().mockResolvedValue(ICS);
    const service = createNextEventService([fetchIcs]);
    await service.getNextEvent(NOW);
    await service.getNextEvent(new Date(NOW.getTime() + NEXT_EVENT_OK_CACHE_TTL_MS + 1));
    expect(fetchIcs).toHaveBeenCalledTimes(2);
  });

  it("zlyhanie fetchu vráti { ok: false }, NIKDY nehodí výnimku ďalej", async () => {
    const fetchIcs = vi.fn().mockRejectedValue(new Error("simulovaný výpadok"));
    const service = createNextEventService([fetchIcs]);
    await expect(service.getNextEvent(NOW)).resolves.toEqual({ ok: false });
  });

  // issue 382: majiteľ chce TRI najbližšie udalosti — `getNextEvent` vracia
  // pole (`events`), nie singulárnu `event` hodnotu.
  it("nakonfigurované s TROMI budúcimi udalosťami vráti pole VŠETKÝCH troch (limit 3)", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:e1@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Prvá",
      "DTSTART;TZID=Europe/Bratislava:20260809T090000",
      "DTEND;TZID=Europe/Bratislava:20260809T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:e2@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Druhá",
      "DTSTART;TZID=Europe/Bratislava:20260810T090000",
      "DTEND;TZID=Europe/Bratislava:20260810T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:e3@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Tretia",
      "DTSTART;TZID=Europe/Bratislava:20260811T090000",
      "DTEND;TZID=Europe/Bratislava:20260811T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const fetchIcs = vi.fn().mockResolvedValue(ics);
    const service = createNextEventService([fetchIcs]);
    const result = await service.getNextEvent(NOW);
    expect(result.ok).toBe(true);
    expect(result.ok && result.events.map((e) => e.title)).toEqual(["Prvá", "Druhá", "Tretia"]);
  });

  it("zlyhanie sa cachuje LEN na kratšiu error TTL — po jej uplynutí appka skúsi znova", async () => {
    const fetchIcs = vi.fn().mockRejectedValueOnce(new Error("výpadok")).mockResolvedValueOnce(ICS);
    const service = createNextEventService([fetchIcs]);
    await service.getNextEvent(NOW);
    // Ešte v error TTL okne — nemá skúšať znova.
    await service.getNextEvent(new Date(NOW.getTime() + NEXT_EVENT_ERROR_CACHE_TTL_MS - 1));
    expect(fetchIcs).toHaveBeenCalledTimes(1);
    // Po uplynutí error TTL — skúsi znova a tentokrát uspeje.
    const result = await service.getNextEvent(new Date(NOW.getTime() + NEXT_EVENT_ERROR_CACHE_TTL_MS + 1));
    expect(fetchIcs).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, events: [] });
  });

  it("úspešné-ale-prázdne (žiadna udalosť) sa cachuje ako úspešný výsledok, nie ako chyba", async () => {
    const fetchIcs = vi.fn().mockResolvedValue(ICS);
    const service = createNextEventService([fetchIcs]);
    const result = await service.getNextEvent(NOW);
    expect(result).toEqual({ ok: true, events: [] });
  });

  it("SÚBEŽNÉ volania počas prebiehajúceho fetchu zdieľajú JEDEN prísľub — fetchIcs sa zavolá len raz", async () => {
    let resolveFetch: (value: string) => void = () => {
      throw new Error("nemalo sa zavolať pred nastavením");
    };
    const fetchIcs = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const service = createNextEventService([fetchIcs]);
    const first = service.getNextEvent(NOW);
    const second = service.getNextEvent(NOW);
    resolveFetch(ICS);
    await Promise.all([first, second]);
    expect(fetchIcs).toHaveBeenCalledTimes(1);
  });

  // issue 469: karta číta VIAC kalendárov — service dostane pole fetcherov,
  // stiahne ich paralelne a zlúči udalosti do jedného poľa.
  it("viac kalendárov — udalosti zo VŠETKÝCH sa zlúčia a zoradia podľa začiatku (issue 469)", async () => {
    const icsA = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:a1@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Kalendár A",
      "DTSTART;TZID=Europe/Bratislava:20260809T090000",
      "DTEND;TZID=Europe/Bratislava:20260809T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const icsB = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:b1@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Kalendár B",
      "DTSTART;TZID=Europe/Bratislava:20260810T090000",
      "DTEND;TZID=Europe/Bratislava:20260810T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const fetchA = vi.fn().mockResolvedValue(icsA);
    const fetchB = vi.fn().mockResolvedValue(icsB);
    const service = createNextEventService([fetchA, fetchB]);
    const result = await service.getNextEvent(NOW);
    expect(result.ok).toBe(true);
    expect(result.ok && result.events.map((e) => e.title)).toEqual(["Kalendár A", "Kalendár B"]);
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it("keď JEDEN z viacerých kalendárov zlyhá, celý výsledok je ok:false — nikdy čiastočný pohľad (issue 469)", async () => {
    const ok = vi.fn().mockResolvedValue(ICS);
    const fail = vi.fn().mockRejectedValue(new Error("výpadok jedného kalendára"));
    const service = createNextEventService([ok, fail]);
    await expect(service.getNextEvent(NOW)).resolves.toEqual({ ok: false });
  });
});
