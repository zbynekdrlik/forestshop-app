import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChangePasswordForm } from "./ChangePasswordForm.js";

const { postChangePassword, PasswordChangeUnauthorizedError } = vi.hoisted(() => {
  class PasswordChangeUnauthorizedError extends Error {}
  return { postChangePassword: vi.fn(), PasswordChangeUnauthorizedError };
});
vi.mock("../passwordApi.js", () => ({ postChangePassword, PasswordChangeUnauthorizedError }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function vyplnIba(polia: { stareHeslo?: string; noveHeslo?: string; potvrdenie?: string }): void {
  if (polia.stareHeslo !== undefined) {
    fireEvent.change(screen.getByLabelText("Staré heslo"), { target: { value: polia.stareHeslo } });
  }
  if (polia.noveHeslo !== undefined) {
    fireEvent.change(screen.getByLabelText("Nové heslo"), { target: { value: polia.noveHeslo } });
  }
  if (polia.potvrdenie !== undefined) {
    fireEvent.change(screen.getByLabelText("Nové heslo znova"), { target: { value: polia.potvrdenie } });
  }
}

function odosli(): void {
  fireEvent.click(screen.getByRole("button", { name: "Zmeniť heslo" }));
}

it("nezhodujúce sa potvrdenie nového hesla ukáže chybu a nezavolá server", () => {
  render(<ChangePasswordForm onSessionExpired={() => {}} />);
  vyplnIba({ stareHeslo: "stare-heslo", noveHeslo: "nove-heslo-123", potvrdenie: "ine-heslo-456" });
  odosli();

  expect(screen.getByRole("alert").textContent).toBe("Nové heslo a jeho potvrdenie sa nezhodujú");
  expect(postChangePassword).not.toHaveBeenCalled();
});

it("príliš krátke nové heslo ukáže chybu a nezavolá server", () => {
  render(<ChangePasswordForm onSessionExpired={() => {}} />);
  vyplnIba({ stareHeslo: "stare-heslo", noveHeslo: "krat", potvrdenie: "krat" });
  odosli();

  expect(screen.getByRole("alert").textContent).toBe("Nové heslo musí mať aspoň 8 znakov");
  expect(postChangePassword).not.toHaveBeenCalled();
});

it("úspešná zmena ukáže potvrdenie a vyprázdni polia", async () => {
  postChangePassword.mockResolvedValue({ ok: true });
  render(<ChangePasswordForm onSessionExpired={() => {}} />);
  vyplnIba({ stareHeslo: "stare-heslo", noveHeslo: "nove-heslo-123", potvrdenie: "nove-heslo-123" });
  odosli();

  await screen.findByTestId("password-change-success");
  expect(postChangePassword).toHaveBeenCalledWith("stare-heslo", "nove-heslo-123");
  expect(screen.getByLabelText<HTMLInputElement>("Staré heslo").value).toBe("");
  expect(screen.getByLabelText<HTMLInputElement>("Nové heslo").value).toBe("");
});

it("zlé staré heslo zo servera ukáže chybovú hlášku servera", async () => {
  postChangePassword.mockResolvedValue({ ok: false, error: "Nesprávne staré heslo" });
  render(<ChangePasswordForm onSessionExpired={() => {}} />);
  vyplnIba({ stareHeslo: "zle-heslo", noveHeslo: "nove-heslo-123", potvrdenie: "nove-heslo-123" });
  odosli();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Nesprávne staré heslo");
});

it("keď relácia medzitým vypršala, zavolá onSessionExpired", async () => {
  postChangePassword.mockRejectedValue(new PasswordChangeUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<ChangePasswordForm onSessionExpired={onSessionExpired} />);
  vyplnIba({ stareHeslo: "stare-heslo", noveHeslo: "nove-heslo-123", potvrdenie: "nove-heslo-123" });
  odosli();

  await waitFor(() => { expect(onSessionExpired).toHaveBeenCalledTimes(1); });
});

it("tlačidlo sa počas prebiehajúcej požiadavky vypne a druhý klik nevyšle ďalšiu požiadavku", async () => {
  let resolvePost: (result: { ok: true }) => void = () => {
    throw new Error("resolvePost nebol nastavený");
  };
  postChangePassword.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
  );

  render(<ChangePasswordForm onSessionExpired={() => {}} />);
  vyplnIba({ stareHeslo: "stare-heslo", noveHeslo: "nove-heslo-123", potvrdenie: "nove-heslo-123" });
  odosli();

  const tlacidlo = await screen.findByRole("button", { name: "Zmeniť heslo" });
  await waitFor(() => { expect(tlacidlo.hasAttribute("disabled")).toBe(true); });

  fireEvent.click(tlacidlo);
  expect(postChangePassword).toHaveBeenCalledTimes(1);

  resolvePost({ ok: true });
  await waitFor(() => { expect(tlacidlo.hasAttribute("disabled")).toBe(false); });
  expect(postChangePassword).toHaveBeenCalledTimes(1);
});
