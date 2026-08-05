import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeColorPicker } from "./ThemeColorPicker.js";

const { fetchThemeColors, saveThemeColors, resetThemeColors } = vi.hoisted(() => ({
  fetchThemeColors: vi.fn(),
  saveThemeColors: vi.fn(),
  resetThemeColors: vi.fn(),
}));

vi.mock("../themeColorsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../themeColorsApi.js")>();
  return { ...actual, fetchThemeColors, saveThemeColors, resetThemeColors };
});

const COLORS = [
  { key: "chip-done-bg", label: "Vybavený dodávateľ — pozadie", value: "#d14d3b", defaultValue: "#d14d3b", isCustomized: false, updatedAt: null, updatedByName: null },
  { key: "chip-done-text", label: "Vybavený dodávateľ — text", value: "#ffffff", defaultValue: "#ffffff", isCustomized: false, updatedAt: null, updatedByName: null },
  { key: "chip-todo-bg", label: "Nespracovaný dodávateľ — pozadie", value: "#6cab68", defaultValue: "#6cab68", isCustomized: false, updatedAt: null, updatedByName: null },
  { key: "chip-todo-text", label: "Nespracovaný dodávateľ — text", value: "#173617", defaultValue: "#173617", isCustomized: false, updatedAt: null, updatedByName: null },
  { key: "chip-active-bg", label: "Práve zvolená bublinka — pozadie", value: "#dda43c", defaultValue: "#dda43c", isCustomized: false, updatedAt: null, updatedByName: null },
  { key: "chip-active-text", label: "Práve zvolená bublinka — text", value: "#3b1d00", defaultValue: "#3b1d00", isCustomized: false, updatedAt: null, updatedByName: null },
];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  document.documentElement.removeAttribute("style");
});

function cssVar(key: string): string {
  return document.documentElement.style.getPropertyValue(`--${key}`);
}

it("pre rolu „citanie“ sa tlačidlo vôbec nevykreslí", () => {
  render(<ThemeColorPicker role="citanie" onSessionExpired={vi.fn()} />);
  expect(screen.queryByTestId("themecolor-btn")).toBeNull();
});

it("pre rolu „sef“ sa tlačidlo vôbec nevykreslí", () => {
  render(<ThemeColorPicker role="sef" onSessionExpired={vi.fn()} />);
  expect(screen.queryByTestId("themecolor-btn")).toBeNull();
});

it("pre manažéra sa tlačidlo vykreslí a klik naň otvorí popup s načítanými farbami", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  render(<ThemeColorPicker role="manazer" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");
  expect(screen.getByTestId<HTMLInputElement>("themecolor-hex-chip-done-bg").value).toBe("#d14d3b");
});

it("zmena hex poľa naživo premietne farbu do CSS premennej na document.documentElement", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");

  fireEvent.change(screen.getByTestId("themecolor-hex-chip-done-bg"), { target: { value: "#123456" } });
  expect(cssVar("chip-done-bg")).toBe("#123456");
});

it("neplatný kód farby sa premietne do poľa, ale NEZAPÍŠE do CSS premennej, a Uložiť ostáva nedostupné", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");

  const save = screen.getByTestId<HTMLButtonElement>("themecolor-save");
  expect(save.disabled).toBe(true); // nič sa nezmenilo

  fireEvent.change(screen.getByTestId("themecolor-hex-chip-done-bg"), { target: { value: "nieco-zle" } });
  expect(cssVar("chip-done-bg")).toBe("#d14d3b"); // pôvodná hodnota, nie garbage
  expect(save.disabled).toBe(true); // draft je síce "dirty", ale neplatný
});

it("Uložiť odošle celý draft a po úspechu popup zavrie", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  saveThemeColors.mockResolvedValue({ ok: true });
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");

  fireEvent.change(screen.getByTestId("themecolor-hex-chip-done-bg"), { target: { value: "#123456" } });
  fireEvent.click(screen.getByTestId("themecolor-save"));

  await waitFor(() => {
    expect(saveThemeColors).toHaveBeenCalledWith(expect.objectContaining({ "chip-done-bg": "#123456" }));
  });
  await waitFor(() => {
    expect(screen.queryByTestId("themecolor-dialog")).toBeNull();
  });
});

it("zamietnuté uloženie zobrazí hlášku servera a popup neZAVRIE", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  saveThemeColors.mockResolvedValue({ ok: false, error: "Neplatný kód farby." });
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");

  fireEvent.change(screen.getByTestId("themecolor-hex-chip-done-bg"), { target: { value: "#123456" } });
  fireEvent.click(screen.getByTestId("themecolor-save"));

  await screen.findByText("Neplatný kód farby.");
  expect(screen.getByTestId("themecolor-dialog")).not.toBeNull();
});

it("Zrušiť vráti CSS premenné na hodnotu pri otvorení a zavrie popup", async () => {
  fetchThemeColors.mockResolvedValue(COLORS);
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");

  fireEvent.change(screen.getByTestId("themecolor-hex-chip-done-bg"), { target: { value: "#123456" } });
  expect(cssVar("chip-done-bg")).toBe("#123456");

  fireEvent.click(screen.getByTestId("themecolor-cancel"));
  expect(cssVar("chip-done-bg")).toBe("#d14d3b");
  expect(screen.queryByTestId("themecolor-dialog")).toBeNull();
});

it("Obnoviť predvolené zapíše predvolené hodnoty a nechá popup otvorený", async () => {
  fetchThemeColors.mockResolvedValue(COLORS.map((c) => (c.key === "chip-done-bg" ? { ...c, value: "#111111", isCustomized: true } : c)));
  resetThemeColors.mockResolvedValue({ ok: true });
  render(<ThemeColorPicker role="admin" onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByTestId("themecolor-btn"));
  await screen.findByTestId("themecolor-dialog");
  expect(screen.getByTestId<HTMLInputElement>("themecolor-hex-chip-done-bg").value).toBe("#111111");

  fireEvent.click(screen.getByTestId("themecolor-reset"));

  await waitFor(() => {
    expect(resetThemeColors).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>("themecolor-hex-chip-done-bg").value).toBe("#d14d3b");
  });
  expect(cssVar("chip-done-bg")).toBe("#d14d3b");
  expect(screen.getByTestId("themecolor-dialog")).not.toBeNull();
});
