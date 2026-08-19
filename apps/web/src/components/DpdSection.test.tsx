import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DpdSection } from "./DpdSection.js";

const { fetchDpdShippableOrders, fetchDpdPreview, sendDpdShipments, requestDpdPickup } = vi.hoisted(() => ({
  fetchDpdShippableOrders: vi.fn(),
  fetchDpdPreview: vi.fn(),
  sendDpdShipments: vi.fn(),
  requestDpdPickup: vi.fn(),
}));

// `DpdUnauthorizedError` ostáva SKUTOČNÁ trieda — rovnaký dôvod ako
// `RestockLinkSuggestionsSection.test.tsx`: `instanceof` v komponente musí
// fungovať aj v teste.
vi.mock("../dpdApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dpdApi.js")>();
  return { ...actual, fetchDpdShippableOrders, fetchDpdPreview, sendDpdShipments, requestDpdPickup };
});

const { DpdUnauthorizedError } = await import("../dpdApi.js");

const ORDER_A = {
  placedAt: "2026-08-01T10:00:00Z",
  lastFailure: null,
  preview: {
    orderId: "order-a",
    externalOrderId: "20700001",
    recipientName: "Ján Novák",
    recipientCompany: null,
    recipientPhone: "+421900123456",
    street: "Hlavná",
    houseNumber: "12",
    city: "Poprad",
    zip: "05801",
    countryName: "Slovensko",
    addressComplete: true,
    weightKg: "1.00",
    isCod: true,
    codAmount: "32.50",
  },
};

const ORDER_B_NO_ADDRESS = {
  placedAt: "2026-08-02T10:00:00Z",
  lastFailure: "portál nedostupný",
  preview: {
    orderId: "order-b",
    externalOrderId: "20700002",
    recipientName: "Eva Malá",
    recipientCompany: null,
    recipientPhone: null,
    street: null,
    houseNumber: null,
    city: null,
    zip: null,
    countryName: null,
    addressComplete: false,
    weightKg: "1.00",
    isCod: false,
    codAmount: null,
  },
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď appka nie je nakonfigurovaná, zobrazí upozornenie", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: false, orders: [] });

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("dpd-not-configured");
  expect(screen.getByTestId("dpd-empty")).toBeDefined();
});

it("prázdny zoznam zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [] });

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("dpd-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("objednávka s neúplnou adresou má zablokovaný checkbox a zobrazí 'Chýba adresa'", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [ORDER_B_NO_ADDRESS] });

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("dpd-address-incomplete-20700002");
  const checkbox = screen.getByLabelText<HTMLInputElement>("Vybrať objednávku 20700002");
  expect(checkbox.disabled).toBe(true);
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchDpdShippableOrders.mockRejectedValue(new DpdUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<DpdSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("rola citanie nemôže vybrať objednávku ani vidieť tlačidlo 'Objednať prepravu DPD'", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [ORDER_A] });

  render(<DpdSection role="citanie" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByLabelText<HTMLInputElement>("Vybrať objednávku 20700001");
  expect(checkbox.disabled).toBe(true);
  expect(screen.queryByTestId("dpd-open-preview")).toBeNull();
});

it("výber objednávky → náhľad → potvrdenie odošle IBA po druhom kliku, nikdy pri otvorení náhľadu", async () => {
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [ORDER_A] });
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [] });
  fetchDpdPreview.mockResolvedValue([ORDER_A.preview]);
  sendDpdShipments.mockResolvedValue([{ orderId: "order-a", ok: true, parcelNumber: "06565000000042" }]);

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByLabelText("Vybrať objednávku 20700001"));
  fireEvent.click(screen.getByTestId("dpd-open-preview"));

  await screen.findByTestId("dpd-preview-dialog");
  expect(sendDpdShipments).not.toHaveBeenCalled();
  expect(screen.getByTestId("dpd-preview-item-20700001").textContent).toContain("Hlavná 12, Poprad 05801, Slovensko");

  fireEvent.click(screen.getByTestId("dpd-preview-confirm"));

  await waitFor(() => {
    expect(sendDpdShipments).toHaveBeenCalledWith(["order-a"], {});
  });
  await screen.findByTestId("dpd-result-order-a");
  expect(screen.getByTestId("dpd-result-order-a").textContent).toContain("06565000000042");
  expect(screen.queryByTestId("dpd-preview-dialog")).toBeNull();
});

it("úprava hmotnosti v riadku sa pošle ako weightOverride do náhľadu aj odoslania", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [ORDER_A] });
  fetchDpdPreview.mockResolvedValue([{ ...ORDER_A.preview, weightKg: "2.50" }]);

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByLabelText("Vybrať objednávku 20700001"));
  const weightInput = screen.getByLabelText<HTMLInputElement>("Hmotnosť objednávky 20700001");
  fireEvent.change(weightInput, { target: { value: "2.50" } });

  fireEvent.click(screen.getByTestId("dpd-open-preview"));

  await waitFor(() => {
    expect(fetchDpdPreview).toHaveBeenCalledWith(["order-a"], { "order-a": "2.50" });
  });
});

it("Objednať zvoz na deň zavolá requestDpdPickup s vybraným dátumom a zobrazí výsledok", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [] });
  requestDpdPickup.mockResolvedValue({ ok: true, error: null });

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("dpd-pickup");
  const dateInput = screen.getByLabelText<HTMLInputElement>("Objednať zvoz na deň");
  fireEvent.change(dateInput, { target: { value: "2026-08-10" } });
  fireEvent.click(screen.getByTestId("dpd-pickup-submit"));

  await waitFor(() => {
    expect(requestDpdPickup).toHaveBeenCalledWith("2026-08-10");
  });
  expect(screen.getByTestId("dpd-pickup-message").textContent).toContain("Zvoz objednaný.");
});

// issue 445: viditeľný feedback (role=status) pri hornom tlačidle po odoslaní.
it("po úspešnom odoslaní ukáže role=status súhrn 'Objednané: N zásielok' pri hornom tlačidle", async () => {
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [ORDER_A] });
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [] });
  fetchDpdPreview.mockResolvedValue([ORDER_A.preview]);
  sendDpdShipments.mockResolvedValue([{ orderId: "order-a", ok: true, parcelNumber: "06565000000042" }]);

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByLabelText("Vybrať objednávku 20700001"));
  fireEvent.click(screen.getByTestId("dpd-open-preview"));
  await screen.findByTestId("dpd-preview-dialog");
  fireEvent.click(screen.getByTestId("dpd-preview-confirm"));

  const notice = await screen.findByTestId("dpd-send-notice");
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toBe("Objednané: 1 zásielka");
});

it("pri čiastočnom úspechu ukáže súhrn 'N úspešných, M chýb'", async () => {
  const orderC = { ...ORDER_A, preview: { ...ORDER_A.preview, orderId: "order-c", externalOrderId: "20700003" } };
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [ORDER_A, orderC] });
  fetchDpdShippableOrders.mockResolvedValueOnce({ configured: true, orders: [orderC] });
  fetchDpdPreview.mockResolvedValue([ORDER_A.preview, orderC.preview]);
  sendDpdShipments.mockResolvedValue([
    { orderId: "order-a", ok: true, parcelNumber: "06565000000042" },
    { orderId: "order-c", ok: false, error: "portál nedostupný" },
  ]);

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByLabelText("Vybrať objednávku 20700001"));
  fireEvent.click(screen.getByLabelText("Vybrať objednávku 20700003"));
  fireEvent.click(screen.getByTestId("dpd-open-preview"));
  await screen.findByTestId("dpd-preview-dialog");
  fireEvent.click(screen.getByTestId("dpd-preview-confirm"));

  const notice = await screen.findByTestId("dpd-send-notice");
  expect(notice.textContent).toBe("1 úspešná, 1 chyba");
});

it("tlačidlo 'Objednať prepravu DPD' je v DOM PRED tabuľkou (hore, nie na konci)", async () => {
  fetchDpdShippableOrders.mockResolvedValue({ configured: true, orders: [ORDER_A] });

  render(<DpdSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("dpd-open-preview");
  const section = screen.getByTestId("dpd-section");
  const nodes = [...section.querySelectorAll("[data-testid='dpd-open-preview'], table")];
  expect(nodes[0]?.getAttribute("data-testid")).toBe("dpd-open-preview");
});
