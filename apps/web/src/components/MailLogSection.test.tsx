import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MailLogSection } from "./MailLogSection.js";

const { fetchMailLog } = vi.hoisted(() => ({ fetchMailLog: vi.fn() }));

// `MailLogUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `MailTemplatesSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../mailLogApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailLogApi.js")>();
  return { ...actual, fetchMailLog };
});

const { MailLogUnauthorizedError } = await import("../mailLogApi.js");

const RIADOK = {
  id: "r1",
  createdAt: "2026-08-03T08:30:00.000Z",
  source: "posta_uncollected" as const,
  status: "sent" as const,
  trigger: "scheduled" as const,
  templateKey: "posta_1",
  recipient: "zakaznik@example.com",
  subject: "Zásielka čaká na pošte",
  orderCode: "20260001",
  variantCode: null,
  packageNumber: "RR123456789SK",
  sequence: 1,
  // issue 277: skutočne odoslaný text — `null` len pre "preskočené" (nižšie).
  body: "Dobrý deň,\n\nvaša zásielka čaká na pošte.",
  reason: null,
  actorName: null,
  adminLink: "https://www.forestshop.sk/admin/objednavky-detail/?id=1",
};

const DUPLICITA = {
  ...RIADOK,
  id: "r2",
  status: "skipped" as const,
  trigger: "manual" as const,
  actorName: "Zbyněk",
  source: "nedostupne" as const,
  sequence: null,
  body: null,
  reason: "už bolo odoslané skôr — druhý e-mail sa neposiela",
};

const SUHRN = { sent: 3, failed: 1, skipped: 2, duplicatesBlocked: 1 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderSection(rows: readonly unknown[] = [RIADOK, DUPLICITA]) {
  fetchMailLog.mockResolvedValue({ rows, summary: SUHRN, period: "30" });
  render(<MailLogSection onSessionExpired={vi.fn()} />);
}

it("zobrazí súhrn za obdobie vrátane zabránených duplicít", async () => {
  renderSection();
  await screen.findByTestId("mail-log-summary");
  expect(screen.getByTestId("mail-log-sum-sent").textContent).toContain("3");
  expect(screen.getByTestId("mail-log-sum-failed").textContent).toContain("1");
  expect(screen.getByTestId("mail-log-sum-skipped").textContent).toContain("2");
  expect(screen.getByTestId("mail-log-sum-duplicates").textContent).toContain("1");
});

it("v riadku je vidno komu, čoho sa e-mail týkal aj poradie upozornenia", async () => {
  renderSection();
  const riadok = await screen.findByTestId("mail-log-row-r1");
  expect(riadok.textContent).toContain("zakaznik@example.com");
  expect(riadok.textContent).toContain("objednávka 20260001");
  expect(riadok.textContent).toContain("zásielka RR123456789SK");
  expect(riadok.textContent).toContain("1. upozornenie");
  expect(riadok.textContent).toContain("Odoslané");
});

it("zablokovaná duplicita je vidno aj s menom zamestnanca, ktorý ju vyvolal", async () => {
  renderSection();
  const riadok = await screen.findByTestId("mail-log-row-r2");
  expect(riadok.textContent).toContain("Preskočené");
  expect(riadok.textContent).toContain("už bolo odoslané skôr");
  expect(riadok.textContent).toContain("Zbyněk");
});

// issue 277: kniha musí vedieť ukázať SKUTOČNE odoslaný text — inak by
// akceptačná podmienka "kniha nesmie klamať" nebola overiteľná na obrazovke.
it("riadok s uloženým textom má tlačidlo na jeho zobrazenie; riadok bez textu (preskočené) ho nemá", async () => {
  renderSection();
  const riadokSoTextom = await screen.findByTestId("mail-log-row-r1");
  expect(riadokSoTextom.textContent).not.toContain("vaša zásielka čaká na pošte");

  fireEvent.click(screen.getByTestId("mail-log-body-toggle-r1"));
  await screen.findByText(/vaša zásielka čaká na pošte/);

  expect(screen.queryByTestId("mail-log-body-toggle-r2")).toBeNull();
});

it("zmena filtra automatizácie znovu načíta prehľad s tým filtrom", async () => {
  renderSection();
  await screen.findByTestId("mail-log-table");
  fireEvent.change(screen.getByTestId("mail-log-filter-source"), { target: { value: "order_reminder" } });
  await waitFor(() => {
    expect(fetchMailLog).toHaveBeenLastCalledWith({ source: "order_reminder", status: "", period: "30" });
  });
});

it("zmena obdobia znovu načíta prehľad s tým obdobím", async () => {
  renderSection();
  await screen.findByTestId("mail-log-table");
  fireEvent.change(screen.getByTestId("mail-log-filter-period"), { target: { value: "7" } });
  await waitFor(() => {
    expect(fetchMailLog).toHaveBeenLastCalledWith({ source: "", status: "", period: "7" });
  });
});

it("prázdny prehľad povie, že sa nič neposielalo — nie prázdnu tabuľku", async () => {
  renderSection([]);
  await screen.findByTestId("mail-log-empty");
  expect(screen.queryByTestId("mail-log-table")).toBeNull();
});

// issue 521: dve rýchle zmeny filtra za sebou vystrelia DVA fetche naraz; keď
// sa STARŠÍ (širší) fetch vráti AŽ PO novom (užšom, prázdnom), NESMIE prepísať
// prázdny výsledok najnovšieho filtra. Rovnaký stale-response guard ako issues
// 251/254/264. Bez guardu tabuľka „ožije" späť namiesto prázdneho stavu — presne
// CI flake `mail-log.spec.ts:54` (`mail-log-empty` sa nikdy nevykreslí).
it("zastaraná odpoveď staršieho filtra neprepíše prázdny výsledok najnovšieho (issue 521)", async () => {
  const deferreds: Array<(value: unknown) => void> = [];
  fetchMailLog.mockImplementation(
    () =>
      new Promise((resolve) => {
        deferreds.push(resolve);
      }),
  );
  render(<MailLogSection onSessionExpired={vi.fn()} />);

  // Prvé (počiatočné) načítanie vráti riadky → tabuľka + filtre sa vykreslia.
  await waitFor(() => {
    expect(deferreds).toHaveLength(1);
  });
  await act(async () => {
    deferreds[0]?.({ rows: [RIADOK, DUPLICITA], summary: SUHRN, period: "30" });
    await Promise.resolve();
  });
  expect(screen.queryByTestId("mail-log-table")).not.toBeNull();

  // Dve rýchle zmeny filtra za sebou → DVA fetche naraz v lete.
  fireEvent.change(screen.getByTestId("mail-log-filter-source"), { target: { value: "order_reminder" } }); // starší → riadky
  fireEvent.change(screen.getByTestId("mail-log-filter-status"), { target: { value: "failed" } }); // novší → prázdno
  await waitFor(() => {
    expect(deferreds).toHaveLength(3);
  });

  // Novší (status=failed) sa vráti PRVÝ → prázdny stav.
  await act(async () => {
    deferreds[2]?.({ rows: [], summary: SUHRN, period: "30" });
    await Promise.resolve();
  });
  expect(screen.queryByTestId("mail-log-empty")).not.toBeNull();

  // Starší (zmena zdroja) sa vráti NESKÔR s riadkami — zastaraný, NESMIE prepísať.
  await act(async () => {
    deferreds[1]?.({ rows: [RIADOK, DUPLICITA], summary: SUHRN, period: "30" });
    await Promise.resolve();
  });
  expect(screen.queryByTestId("mail-log-empty")).not.toBeNull();
  expect(screen.queryByTestId("mail-log-table")).toBeNull();
});

it("401 pri načítaní zavolá onSessionExpired", async () => {
  const onSessionExpired = vi.fn();
  fetchMailLog.mockRejectedValue(new MailLogUnauthorizedError());
  render(<MailLogSection onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
