import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderReminderSection } from "./OrderReminderSection.js";

const {
  fetchOrderReminderStatus,
  setOrderReminderEnabled,
  runOrderReminderNow,
  overrideOrderReminder,
  fetchOrderReminderPreview,
} = vi.hoisted(() => ({
  fetchOrderReminderStatus: vi.fn(),
  setOrderReminderEnabled: vi.fn(),
  runOrderReminderNow: vi.fn(),
  overrideOrderReminder: vi.fn(),
  fetchOrderReminderPreview: vi.fn(),
}));

// `OrderReminderUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `PostaUncollectedSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../orderReminderApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderReminderApi.js")>();
  return { ...actual, fetchOrderReminderStatus, setOrderReminderEnabled, runOrderReminderNow, overrideOrderReminder, fetchOrderReminderPreview };
});

const { OrderReminderUnauthorizedError } = await import("../orderReminderApi.js");

const NO_NOTE_ROW = {
  orderCode: "20600001",
  adminLink: "https://www.forestshop.sk/admin/vyhladavanie/?string=20600001&src=orders",
  name: "Ján Novák",
  phone: "+421900000000",
  email: "jan@example.sk",
  itemLabel: "Nohavice Hart Wild-T",
  days: 5,
};

const RUN_RESULT = {
  checkedAt: "2026-08-02T06:00:00.000Z",
  noNote: [NO_NOTE_ROW],
  noEmail: [],
  emailed: [],
  contacted: [],
  pending: [],
  aiNotConfigured: false,
  bccMissing: false,
  mailNotConfigured: false,
  stats: { candidates: 1, noNoteCount: 1, noEmailCount: 0, emailedNow: 0, contactedNow: 0, pendingCount: 0 },
};

const STATUS_WITH_RESULT = {
  enabled: true,
  lastRun: {
    startedAt: "2026-08-02T06:00:00.000Z",
    finishedAt: "2026-08-02T06:00:05.000Z",
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
  fetchOrderReminderStatus.mockResolvedValue({ enabled: false, lastRun: null });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);

  const prazdny = await screen.findByTestId("order-reminder-empty");
  expect(prazdny.textContent).toContain("Spustiť teraz");
  expect(screen.getByTestId("order-reminder-status-pill").textContent).toBe("Zastavené");
});

it("rola citanie vidí tabuľku, ale NEVIDÍ Štart/Stop ani Spustiť teraz", async () => {
  fetchOrderReminderStatus.mockResolvedValue(STATUS_WITH_RESULT);

  render(<OrderReminderSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-reminder-red-${NO_NOTE_ROW.orderCode}`);
  expect(screen.queryByTestId("order-reminder-toggle")).toBeNull();
  expect(screen.queryByTestId("order-reminder-run-now")).toBeNull();
});

it("manazer vidí Štart/Stop a klik prepne stav", async () => {
  fetchOrderReminderStatus.mockResolvedValue({ enabled: false, lastRun: null });
  setOrderReminderEnabled.mockResolvedValue(true);

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId("order-reminder-toggle");

  fetchOrderReminderStatus.mockResolvedValue({ enabled: true, lastRun: null });
  fireEvent.click(screen.getByTestId("order-reminder-toggle"));

  await waitFor(() => {
    expect(setOrderReminderEnabled).toHaveBeenCalledWith(true);
  });
  await waitFor(() => {
    expect(screen.getByTestId("order-reminder-status-pill").textContent).toBe("Beží");
  });
});

it("'✓ Kontaktované' na riadku bez poznámky zavolá override s action='contact' a obnoví zoznam", async () => {
  fetchOrderReminderStatus.mockResolvedValue(STATUS_WITH_RESULT);
  overrideOrderReminder.mockResolvedValue({ ok: true, resolution: "contacted" });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId(`order-reminder-contact-${NO_NOTE_ROW.orderCode}`);
  fireEvent.click(screen.getByTestId(`order-reminder-contact-${NO_NOTE_ROW.orderCode}`));

  await waitFor(() => {
    expect(overrideOrderReminder).toHaveBeenCalledWith(NO_NOTE_ROW.orderCode, "contact");
  });
});

it("'▶ Poslať pripomienku' na riadku bez poznámky zavolá override s action='send'", async () => {
  fetchOrderReminderStatus.mockResolvedValue(STATUS_WITH_RESULT);
  overrideOrderReminder.mockResolvedValue({ ok: true, resolution: "emailed" });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId(`order-reminder-send-${NO_NOTE_ROW.orderCode}`);
  fireEvent.click(screen.getByTestId(`order-reminder-send-${NO_NOTE_ROW.orderCode}`));

  await waitFor(() => {
    expect(overrideOrderReminder).toHaveBeenCalledWith(NO_NOTE_ROW.orderCode, "send");
  });
});

it("zamietnutá ručná akcia (napr. už odoslaná) zobrazí hlášku zo servera", async () => {
  fetchOrderReminderStatus.mockResolvedValue(STATUS_WITH_RESULT);
  overrideOrderReminder.mockResolvedValue({ ok: false, error: "Pripomienka už bola odoslaná." });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByTestId(`order-reminder-send-${NO_NOTE_ROW.orderCode}`));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("už bola odoslaná");
});

it("chýbajúce OPENAI_API_KEY zobrazí varovný banner", async () => {
  fetchOrderReminderStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: { ...STATUS_WITH_RESULT.lastRun, result: { ...RUN_RESULT, aiNotConfigured: true } },
  });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);

  const banner = await screen.findByTestId("order-reminder-ai-not-configured");
  expect(banner.textContent).toContain("OPENAI_API_KEY");
});

it("chýbajúca BCC adresa zobrazí varovný banner", async () => {
  fetchOrderReminderStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: { ...STATUS_WITH_RESULT.lastRun, result: { ...RUN_RESULT, bccMissing: true } },
  });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);

  const banner = await screen.findByTestId("order-reminder-bcc-missing");
  expect(banner.textContent).toContain("skrytú kópiu");
});

it("preskočený riadok (AI kontaktovaný) má náhľad a klik zobrazí presne to, čo by odišlo", async () => {
  const skippedRow = { ...NO_NOTE_ROW, orderCode: "20600002", resolvedAt: "2026-08-01T09:00:00.000Z", resolvedBy: "ai" as const };
  fetchOrderReminderStatus.mockResolvedValue({
    ...STATUS_WITH_RESULT,
    lastRun: { ...STATUS_WITH_RESULT.lastRun, result: { ...RUN_RESULT, noNote: [], contacted: [skippedRow] } },
  });
  fetchOrderReminderPreview.mockResolvedValue({
    ok: true,
    subject: "📦 Stav vašej objednávky z Forestshop.sk",
    html: "<p>ahoj</p>",
    recipient: "jan@example.sk",
    name: "Ján Novák",
    orderCode: "20600002",
  });

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByTestId(`order-reminder-preview-${skippedRow.orderCode}`));

  const preview = await screen.findByTestId("order-reminder-preview");
  expect(preview.textContent).toContain("jan@example.sk");
  expect(runOrderReminderNow).not.toHaveBeenCalled();
});

it("'Spustiť teraz' zavolá beh a obnoví stav", async () => {
  // issue 413: run-now je ASYNC — `runOrderReminderNow()` už neresolvuje
  // výsledok priamo (server 202-ne hneď), komponent ho PREBERIE
  // opakovaným čítaním stavu (`pollUntilJobDone`), preto tu netreba mock
  // rozlíšenej hodnoty niesť.
  fetchOrderReminderStatus.mockResolvedValueOnce({ enabled: true, lastRun: null }).mockResolvedValue(STATUS_WITH_RESULT);
  runOrderReminderNow.mockResolvedValue(undefined);

  render(<OrderReminderSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId("order-reminder-run-now");
  fireEvent.click(screen.getByTestId("order-reminder-run-now"));

  await waitFor(() => {
    expect(runOrderReminderNow).toHaveBeenCalledTimes(1);
  });
  await screen.findByTestId(`order-reminder-red-${NO_NOTE_ROW.orderCode}`);
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchOrderReminderStatus.mockRejectedValue(new OrderReminderUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrderReminderSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
