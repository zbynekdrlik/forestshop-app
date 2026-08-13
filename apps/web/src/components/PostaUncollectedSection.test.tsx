import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PostaUncollectedSection } from "./PostaUncollectedSection.js";

const { fetchPostaUncollectedStatus, setPostaUncollectedEnabled, runPostaUncollectedNow, fetchPostaUncollectedPreview } = vi.hoisted(() => ({
  fetchPostaUncollectedStatus: vi.fn(),
  setPostaUncollectedEnabled: vi.fn(),
  runPostaUncollectedNow: vi.fn(),
  fetchPostaUncollectedPreview: vi.fn(),
}));

// `PostaUncollectedUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod
// ako `SchedulerSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../postaUncollectedApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../postaUncollectedApi.js")>();
  return { ...actual, fetchPostaUncollectedStatus, setPostaUncollectedEnabled, runPostaUncollectedNow, fetchPostaUncollectedPreview };
});

const { PostaUncollectedUnauthorizedError } = await import("../postaUncollectedApi.js");

const SHIPMENT = {
  orderCode: "20300001",
  packageNumber: "EF123456789SK",
  name: "Ján Novák",
  email: "jan@example.sk",
  phone: "+421900000000",
  officeName: "Pošta 1",
  officeAddr: "Hlavná 1, Žilina",
  retainedTill: "2026-08-10",
  notifiedSince: "2026-08-01",
  daysAtPost: 2,
  count: 1,
  lastSentAt: "2026-08-02",
  callNeeded: false,
  trackingLink: "https://www.posta.sk/sledovanie-zasielok#parcel=EF123456789SK",
  adminLink: "https://www.forestshop.sk/admin/vyhladavanie/?string=20300001&src=orders",
};

const RUN_RESULT = {
  checkedAt: "2026-08-02T09:00:00.000Z",
  uncollected: [SHIPMENT],
  invalid: [],
  errors: [],
  coverage: {
    eligibleOrders: 10,
    dispatchedOrders: 8,
    dispatchedWithPackage: 8,
    dispatchedWithoutPackage: 0,
    missingPackage: 0,
    daysSinceLastPackage: 1,
    dispatchedStatusUnknown: false,
    degraded: false,
  },
  bccMissing: false,
  mailNotConfigured: false,
  stats: { checked: 1, uncollectedCount: 1, invalidCount: 0, errorCount: 0, apiSkipped: 0, emailsSent: 1, emailsBlocked: 0 },
};

const STATUS_WITH_RESULT = {
  enabled: true,
  lastRun: {
    startedAt: "2026-08-02T09:00:00.000Z",
    finishedAt: "2026-08-02T09:00:05.000Z",
    status: "success" as const,
    errorMessage: null,
    result: RUN_RESULT,
    skippedReason: null,
  },
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zatiaľ žiadny beh nie je zaznamenaný, zobrazí informačnú vetu s výzvou spustiť", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue({ enabled: false, lastRun: null });

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);

  const prazdny = await screen.findByTestId("posta-empty");
  expect(prazdny.textContent).toContain("Spustiť teraz");
  expect(screen.getByTestId("posta-status-pill").textContent).toBe("Zastavené");
});

it("rola citanie vidí tabuľku, ale NEVIDÍ Štart/Stop ani Spustiť teraz", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue(STATUS_WITH_RESULT);

  render(<PostaUncollectedSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId(`posta-row-${SHIPMENT.packageNumber}`);
  expect(screen.queryByTestId("posta-toggle")).toBeNull();
  expect(screen.queryByTestId("posta-run-now")).toBeNull();
});

it("manazer vidí Štart/Stop a klik prepne stav", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue({ enabled: false, lastRun: null });
  setPostaUncollectedEnabled.mockResolvedValue(true);

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId("posta-toggle");

  fetchPostaUncollectedStatus.mockResolvedValue({ enabled: true, lastRun: null });
  fireEvent.click(screen.getByTestId("posta-toggle"));

  await waitFor(() => {
    expect(setPostaUncollectedEnabled).toHaveBeenCalledWith(true);
  });
  await waitFor(() => {
    expect(screen.getByTestId("posta-status-pill").textContent).toBe("Beží");
  });
});

it("⚠️ TREBA ZAVOLAŤ sa zobrazí len keď callNeeded=true", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: {
      ...STATUS_WITH_RESULT.lastRun,
      result: { ...RUN_RESULT, uncollected: [{ ...SHIPMENT, count: 4, callNeeded: true }] },
    },
  });

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);

  const badge = await screen.findByTestId(`posta-call-needed-${SHIPMENT.packageNumber}`);
  expect(badge.textContent).toContain("TREBA ZAVOLAŤ");
});

it("chýbajúca BCC adresa zobrazí varovný banner", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: { ...STATUS_WITH_RESULT.lastRun, result: { ...RUN_RESULT, bccMissing: true } },
  });

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);

  const banner = await screen.findByTestId("posta-bcc-missing");
  expect(banner.textContent).toContain("skrytú kópiu");
});

it("degradovaný zdroj zásielok zobrazí varovný banner", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: {
      ...STATUS_WITH_RESULT.lastRun,
      result: { ...RUN_RESULT, coverage: { ...RUN_RESULT.coverage, degraded: true, dispatchedWithoutPackage: 6 } },
    },
  });

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);

  const banner = await screen.findByTestId("posta-coverage-degraded");
  expect(banner.textContent).toContain("degradovaný");
});

it("klik na 'Náhľad' zobrazí presne to, čo by odišlo, bez odoslania", async () => {
  fetchPostaUncollectedStatus.mockResolvedValue(STATUS_WITH_RESULT);
  fetchPostaUncollectedPreview.mockResolvedValue({
    ok: true,
    subject: "Pripomienka: zásielka stále čaká | EF123456789SK",
    html: "<p>ahoj</p>",
    recipient: "jan@example.sk",
    name: "Ján Novák",
    packageNumber: SHIPMENT.packageNumber,
    orderCode: SHIPMENT.orderCode,
    count: 2,
    alreadySent: 1,
    maxReached: false,
  });

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);
  const row = await screen.findByTestId(`posta-row-${SHIPMENT.packageNumber}`);
  fireEvent.click(row.querySelector("button") as HTMLButtonElement);

  const preview = await screen.findByTestId("posta-preview");
  expect(preview.textContent).toContain("jan@example.sk");
  expect(preview.textContent).toContain("Pripomienka");
  expect(runPostaUncollectedNow).not.toHaveBeenCalled();
});

it("'Spustiť teraz' zavolá beh a obnoví stav", async () => {
  // issue 413: run-now je ASYNC — `runPostaUncollectedNow()` už neresolvuje
  // výsledok priamo (server 202-ne hneď), komponent ho PREBERIE opakovaným
  // čítaním stavu (`pollUntilJobDone`), preto tu netreba mock rozlíšenej
  // hodnoty niesť.
  fetchPostaUncollectedStatus.mockResolvedValueOnce({ enabled: true, lastRun: null }).mockResolvedValue(STATUS_WITH_RESULT);
  runPostaUncollectedNow.mockResolvedValue(undefined);

  render(<PostaUncollectedSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId("posta-run-now");
  fireEvent.click(screen.getByTestId("posta-run-now"));

  await waitFor(() => {
    expect(runPostaUncollectedNow).toHaveBeenCalledTimes(1);
  });
  await screen.findByTestId(`posta-row-${SHIPMENT.packageNumber}`);
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchPostaUncollectedStatus.mockRejectedValue(new PostaUncollectedUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<PostaUncollectedSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
