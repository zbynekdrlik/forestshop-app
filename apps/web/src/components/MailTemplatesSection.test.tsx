import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MailTemplatesSection } from "./MailTemplatesSection.js";

const { fetchMailTemplates, fetchMailTemplatePreview, saveMailTemplate, resetMailTemplate, fetchMailTemplateHistory } = vi.hoisted(() => ({
  fetchMailTemplates: vi.fn(),
  fetchMailTemplatePreview: vi.fn(),
  saveMailTemplate: vi.fn(),
  resetMailTemplate: vi.fn(),
  fetchMailTemplateHistory: vi.fn(),
}));

// `MailTemplatesUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `NedostupneSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../mailTemplatesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailTemplatesApi.js")>();
  return { ...actual, fetchMailTemplates, fetchMailTemplatePreview, saveMailTemplate, resetMailTemplate, fetchMailTemplateHistory };
});

const { MailTemplatesUnauthorizedError } = await import("../mailTemplatesApi.js");

const NEDOSTUPNE = {
  key: "nedostupne",
  label: "Nedostupný tovar — bez návrhu náhrady",
  description: "Ospravedlnenie zákazníkovi.",
  subject: "Pôvodný predmet",
  body: "Dobrý deň, **{{meno_zakaznika}}**,",
  defaultSubject: "Pôvodný predmet",
  defaultBody: "Dobrý deň, **{{meno_zakaznika}}**,",
  isCustomized: false,
  updatedAt: null,
  updatedByName: null,
  placeholders: [
    { name: "meno_zakaznika", label: "Meno zákazníka" },
    { name: "web_forestshop", label: "Odkaz na www.forestshop.sk" },
  ],
};

const REMINDER = { ...NEDOSTUPNE, key: "order_reminder", label: "Pripomienka objednávky", isCustomized: true, updatedByName: "Zbyněk", updatedAt: "2026-08-03T10:00:00.000Z" };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderSection(role: "admin" | "manazer" | "citanie" = "manazer") {
  fetchMailTemplates.mockResolvedValue([NEDOSTUPNE, REMINDER]);
  fetchMailTemplatePreview.mockResolvedValue({ ok: true, subject: "Pôvodný predmet", html: "<p>Dobrý deň</p>", text: "Dobrý deň" });
  render(<MailTemplatesSection role={role} onSessionExpired={vi.fn()} />);
}

it("zobrazí zoznam druhov e-mailov a otvorí prvý z nich", async () => {
  renderSection();
  await screen.findByTestId("mail-template-list");
  expect(screen.getByTestId("mail-template-pick-nedostupne")).not.toBeNull();
  expect(screen.getByTestId("mail-template-pick-order_reminder")).not.toBeNull();
  await screen.findByTestId("mail-template-editor-nedostupne");
});

it("prepnutie druhu otvorí jeho vlastné znenie", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  fireEvent.click(screen.getByTestId("mail-template-pick-order_reminder"));
  await screen.findByTestId("mail-template-editor-order_reminder");
  expect(screen.getByTestId("mail-template-customized").textContent).toContain("Zbyněk");
});

it("kliknutie na pole ho vloží do textu — netreba ho písať naspamäť", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  const body = screen.getByTestId<HTMLTextAreaElement>("mail-template-body");
  fireEvent.focus(body);
  fireEvent.click(screen.getByTestId("mail-template-chip-web_forestshop"));
  await waitFor(() => {
    expect(body.value).toContain("{{web_forestshop}}");
  });
});

it("uloženie je nedostupné, kým sa nič nezmenilo, a po zmene odošle nové znenie", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  const save = screen.getByTestId<HTMLButtonElement>("mail-template-save");
  expect(save.disabled).toBe(true);

  saveMailTemplate.mockResolvedValue({ ok: true });
  fireEvent.change(screen.getByTestId("mail-template-subject"), { target: { value: "Nový predmet" } });
  await waitFor(() => {
    expect(save.disabled).toBe(false);
  });
  fireEvent.click(save);
  await waitFor(() => {
    expect(saveMailTemplate).toHaveBeenCalledWith("nedostupne", "Nový predmet", NEDOSTUPNE.body);
  });
});

it("zamietnuté uloženie zobrazí hlášku zo servera a znenie neoznačí za uložené", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  saveMailTemplate.mockResolvedValue({ ok: false, error: "Neznáme zástupné pole: {{vymyslene}}." });
  fireEvent.change(screen.getByTestId("mail-template-subject"), { target: { value: "Iný predmet" } });
  fireEvent.click(screen.getByTestId("mail-template-save"));
  await screen.findByText("Neznáme zástupné pole: {{vymyslene}}.");
  expect(screen.queryByTestId("mail-template-saved")).toBeNull();
});

it("vrátenie pôvodného znenia je dostupné len pri upravenej šablóne a vráti pôvodný text do polí", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  expect(screen.getByTestId<HTMLButtonElement>("mail-template-reset").disabled).toBe(true);

  fireEvent.click(screen.getByTestId("mail-template-pick-order_reminder"));
  await screen.findByTestId("mail-template-editor-order_reminder");
  resetMailTemplate.mockResolvedValue({ ok: true });
  fireEvent.click(screen.getByTestId("mail-template-reset"));
  await waitFor(() => {
    expect(resetMailTemplate).toHaveBeenCalledWith("order_reminder");
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>("mail-template-subject").value).toBe(REMINDER.defaultSubject);
  });
});

it("rola citanie NEVIDÍ tlačidlá na úpravu — upravovať smie len admin/manažér", async () => {
  renderSection("citanie");
  await screen.findByTestId("mail-template-editor-nedostupne");
  expect(screen.queryByTestId("mail-template-save")).toBeNull();
  expect(screen.queryByTestId("mail-template-reset")).toBeNull();
});

it("náhľad sa načíta z rozpísaného znenia", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  await waitFor(() => {
    expect(fetchMailTemplatePreview).toHaveBeenCalledWith("nedostupne", NEDOSTUPNE.subject, NEDOSTUPNE.body);
  });
  await screen.findByTestId("mail-template-preview");
});

it("chyba v šablóne sa v náhľade zobrazí namiesto rozbitého e-mailu", async () => {
  fetchMailTemplates.mockResolvedValue([NEDOSTUPNE]);
  fetchMailTemplatePreview.mockResolvedValue({ ok: false, error: "Neznáme zástupné pole: {{zle}}." });
  render(<MailTemplatesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("mail-template-preview-error");
});

it("história zmien sa načíta na požiadanie", async () => {
  renderSection();
  await screen.findByTestId("mail-template-editor-nedostupne");
  fetchMailTemplateHistory.mockResolvedValue([
    { id: "1", action: "save", subject: "Nový predmet", changedAt: "2026-08-03T10:00:00.000Z", changedByName: "Zbyněk" },
  ]);
  fireEvent.click(screen.getByTestId("mail-template-history-load"));
  await screen.findByTestId("mail-template-history");
  expect(screen.getByText(/uložené nové znenie/)).not.toBeNull();
});

it("401 pri načítaní zavolá onSessionExpired", async () => {
  const onSessionExpired = vi.fn();
  fetchMailTemplates.mockRejectedValue(new MailTemplatesUnauthorizedError());
  render(<MailTemplatesSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
