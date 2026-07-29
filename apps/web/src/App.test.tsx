import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const { fetchMe, postLogin, postLogout, fetchVersion } = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  postLogin: vi.fn(),
  postLogout: vi.fn(),
  fetchVersion: vi.fn(),
}));

vi.mock("./api.js", () => ({ fetchMe, postLogin, postLogout, fetchVersion }));

const rejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  rejections.push(reason);
}

beforeEach(() => {
  rejections.length = 0;
  process.on("unhandledRejection", onUnhandledRejection);
  fetchVersion.mockResolvedValue({ version: "0.1.0", commit: "abc" });
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  cleanup();
  vi.resetAllMocks();
});

describe("App", () => {
  it("keď /api/me zlyhá (sieťová chyba), zobrazí hlášku o nedostupnosti servera bez nekonečného 'Načítavam…' a bez nespracovanej výnimky", async () => {
    fetchMe.mockRejectedValue(new Error("network error"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Aplikácia nie je dostupná — server neodpovedá.");
    });
    expect(screen.queryByText("Načítavam…")).toBeNull();
    // Give any pending microtask rejection one tick to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toHaveLength(0);
  });

  it("pri 401 z /api/me (fetchMe vráti null) zobrazí prihlasovací formulár ako predtým", async () => {
    fetchMe.mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Prihlásenie" })).not.toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pri zlyhaní požiadavky na prihlásenie (nie nesprávne heslo, ale zlyhaná požiadavka) zobrazí hlášku 'server neodpovedal'", async () => {
    fetchMe.mockResolvedValue(null);
    postLogin.mockRejectedValue(new Error("network error"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Prihlásenie" })).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "a@b.sk" } });
    fireEvent.change(screen.getByLabelText("Heslo"), { target: { value: "heslo123" } });
    fireEvent.click(screen.getByRole("button", { name: "Prihlásiť sa" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Prihlásenie zlyhalo — server neodpovedal");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toHaveLength(0);
  });
});
