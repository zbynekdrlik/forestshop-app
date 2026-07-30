import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderOpenStatusesPanel } from "./OrderOpenStatusesPanel.js";

const { fetchOpenStatusesConfig, saveOpenStatuses } = vi.hoisted(() => ({
  fetchOpenStatusesConfig: vi.fn(),
  saveOpenStatuses: vi.fn(),
}));

// `OrdersUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu — rovnaký
// dôvod ako `OrdersSection.test.tsx`: `instanceof` v komponente musí fungovať
// aj v teste.
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenStatusesConfig, saveOpenStatuses };
});

const { OrdersUnauthorizedError } = await import("../ordersApi.js");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("panel je predvolene zatvorený a nenačíta nastavenie, kým ho manažér neotvorí", () => {
  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={() => {}} />);
  expect(screen.queryByTestId("order-open-statuses-textarea")).toBeNull();
  expect(fetchOpenStatusesConfig).not.toHaveBeenCalled();
});

it("po otvorení načíta nastavené aj videné stavy a zobrazí ich", async () => {
  fetchOpenStatusesConfig.mockResolvedValue({
    statuses: ["Vybavuje sa", "Osob. odber"],
    knownStatuses: ["Vybavená", "Vybavuje sa", "Osob. odber"],
  });

  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));

  const textarea = await screen.findByTestId<HTMLTextAreaElement>("order-open-statuses-textarea");
  expect(textarea.value).toBe("Vybavuje sa\nOsob. odber");
  expect(screen.getByTestId("order-open-statuses-known").textContent).toContain("Vybavená · Vybavuje sa · Osob. odber");
});

it("uloženie pošle vyčistený (orezaný, bez prázdnych) zoznam a zobrazí očistenú odpoveď servera", async () => {
  fetchOpenStatusesConfig.mockResolvedValue({ statuses: ["Vybavuje sa"], knownStatuses: [] });
  saveOpenStatuses.mockResolvedValue(["Vybavuje sa", "Osob. odber"]);
  const onSaved = vi.fn();

  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));
  const textarea = await screen.findByTestId<HTMLTextAreaElement>("order-open-statuses-textarea");

  fireEvent.change(textarea, { target: { value: "Vybavuje sa\n  \nOsob. odber\n" } });
  fireEvent.click(screen.getByRole("button", { name: "💾 Uložiť" }));

  await waitFor(() => {
    expect(saveOpenStatuses).toHaveBeenCalledWith(["Vybavuje sa", "Osob. odber"]);
  });
  await waitFor(() => {
    expect(textarea.value).toBe("Vybavuje sa\nOsob. odber");
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain("Uložené");
});

it("zlyhané uloženie (napr. prázdny zoznam) zobrazí slovenskú hlášku zo servera", async () => {
  fetchOpenStatusesConfig.mockResolvedValue({ statuses: ["Vybavuje sa"], knownStatuses: [] });
  saveOpenStatuses.mockRejectedValue(new Error("Zoznam stavov nesmie ostať prázdny — musí obsahovať aspoň jeden stav."));
  const onSaved = vi.fn();

  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));
  const textarea = await screen.findByTestId("order-open-statuses-textarea");
  fireEvent.change(textarea, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "💾 Uložiť" }));

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Zoznam stavov nesmie ostať prázdny — musí obsahovať aspoň jeden stav.");
  });
  expect(onSaved).not.toHaveBeenCalled();
  // Regresia: textarea/uložiť tlačidlo MUSIA ostať viditeľné aj po zlyhanom
  // uložení, aby sa dalo skúsiť znova — pôvodná (chybná) podmienka ich
  // skrývala pri akomkoľvek `error`, nielen pri zlyhanom NAČÍTANÍ.
  expect(screen.getByTestId("order-open-statuses-textarea")).toBeTruthy();
  expect(screen.getByRole("button", { name: "💾 Uložiť" })).toBeTruthy();
});

it("keď načítanie zlyhá inou chybou, zobrazí hlášku a NEukáže prázdnu textarea (nemá čo editovať)", async () => {
  fetchOpenStatusesConfig.mockRejectedValue(new Error("network"));

  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Nastavenie otvorených stavov sa nepodarilo načítať.");
  });
  expect(screen.queryByTestId("order-open-statuses-textarea")).toBeNull();
});

it("pri 401 pri načítaní zavolá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchOpenStatusesConfig.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrderOpenStatusesPanel onSessionExpired={onSessionExpired} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("opätovné kliknutie na tlačidlo panel zatvorí bez ďalšieho načítania", async () => {
  fetchOpenStatusesConfig.mockResolvedValue({ statuses: ["Vybavuje sa"], knownStatuses: [] });

  render(<OrderOpenStatusesPanel onSessionExpired={() => {}} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));
  await screen.findByTestId("order-open-statuses-textarea");

  fireEvent.click(screen.getByRole("button", { name: "⌄ Skryť nastavenie stavov objednávok" }));
  expect(screen.queryByTestId("order-open-statuses-textarea")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }));
  await screen.findByTestId("order-open-statuses-textarea");
  expect(fetchOpenStatusesConfig).toHaveBeenCalledTimes(1); // druhé otvorenie znova nenačíta
});
