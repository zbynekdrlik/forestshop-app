import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm.js";

const { postLogin } = vi.hoisted(() => ({ postLogin: vi.fn() }));
vi.mock("../api.js", () => ({ postLogin }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function vyplnAOdošli(): void {
  fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "a@b.sk" } });
  fireEvent.change(screen.getByLabelText("Heslo"), { target: { value: "heslo123" } });
  fireEvent.click(screen.getByRole("button", { name: "Prihlásiť sa" }));
}

it("tlačidlo sa počas prebiehajúcej požiadavky vypne a druhý klik nevyšle ďalšiu požiadavku", async () => {
  let resolvePostLogin: (ok: boolean) => void = () => {
    throw new Error("resolvePostLogin nebol nastavený");
  };
  postLogin.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        resolvePostLogin = resolve;
      }),
  );

  render(<LoginForm onLoggedIn={() => {}} />);
  vyplnAOdošli();

  const tlacidlo = await screen.findByRole("button", { name: "Prihlásiť sa" });
  await waitFor(() => { expect(tlacidlo.hasAttribute("disabled")).toBe(true); });

  // Druhý klik počas prebiehajúcej požiadavky — nesmie vyvolať ďalšie volanie.
  fireEvent.click(tlacidlo);
  expect(postLogin).toHaveBeenCalledTimes(1);

  resolvePostLogin(false);
  await waitFor(() => { expect(tlacidlo.hasAttribute("disabled")).toBe(false); });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Nesprávny e-mail alebo heslo");
  expect(postLogin).toHaveBeenCalledTimes(1);
});

it("po úspešnom prihlásení zavolá onLoggedIn presne raz", async () => {
  postLogin.mockResolvedValue(true);
  const onLoggedIn = vi.fn();

  render(<LoginForm onLoggedIn={onLoggedIn} />);
  vyplnAOdošli();

  await waitFor(() => { expect(onLoggedIn).toHaveBeenCalledTimes(1); });
  expect(postLogin).toHaveBeenCalledTimes(1);
});
