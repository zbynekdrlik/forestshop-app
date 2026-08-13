import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelCandidateRow, TerminalButtons } from "./PairingReviewPanelParts.js";

// issue 398/409 review nález (🔵) — `PairingReviewPanelParts.tsx` je extrahovaný
// súbor bez VLASTNÉHO test súboru (repo's zavedený vzor pre takéto extrakcie,
// napr. `OrderLineRow.*.test.tsx`); správanie bolo dovtedy pokryté len
// nepriamo cez `PairingReviewCard.test.tsx`. Tento súbor testuje OBIDVE
// zložky v izolácii, s vlastnými (nie karta-odvodenými) props.

const CANDIDATE = {
  name: "Top kandidát",
  url: "https://dodavatel.example.com/top",
  imageUrl: "https://dodavatel.example.com/img/top.jpg",
  rawScore: 90,
  codeHit: true,
};

afterEach(() => {
  cleanup();
});

it("TerminalButtons: 📦 odošle {status:'unavailable'}, 🚫 odošle {status:'discontinued'}, oboje nesú testid podľa productKey", () => {
  const submit = vi.fn();
  render(<TerminalButtons busy={false} submit={submit} productKey="PR-X" />);

  fireEvent.click(screen.getByTestId("pairing-review-unavailable-PR-X"));
  expect(submit).toHaveBeenCalledWith({ status: "unavailable" });

  fireEvent.click(screen.getByTestId("pairing-review-discontinued-PR-X"));
  expect(submit).toHaveBeenCalledWith({ status: "discontinued" });
  expect(submit).toHaveBeenCalledTimes(2);
});

it("TerminalButtons: busy=true disabluje OBE tlačidlá", () => {
  render(<TerminalButtons busy={true} submit={vi.fn()} productKey="PR-X" />);

  expect(screen.getByTestId<HTMLButtonElement>("pairing-review-unavailable-PR-X").disabled).toBe(true);
  expect(screen.getByTestId<HTMLButtonElement>("pairing-review-discontinued-PR-X").disabled).toBe(true);
});

it("PanelCandidateRow: kandidát S obrázkom ukáže <img>, klik na 'Vybrať' odošle {status:'manual', url} tohto kandidáta", () => {
  const submit = vi.fn();
  render(<PanelCandidateRow candidate={CANDIDATE} index={2} busy={false} submit={submit} productKey="PR-X" />);

  const img = screen.getByRole("img");
  expect(img.getAttribute("src")).toBe(CANDIDATE.imageUrl);
  expect(screen.queryByText("bez obrázka")).toBeNull();

  fireEvent.click(screen.getByTestId("pairing-review-panel-pick-PR-X-2"));
  expect(submit).toHaveBeenCalledWith({ status: "manual", url: CANDIDATE.url });
});

it("PanelCandidateRow: kandidát BEZ obrázka (imageUrl null) ukáže 'bez obrázka' fallback, nikdy <img>", () => {
  render(<PanelCandidateRow candidate={{ ...CANDIDATE, imageUrl: null }} index={0} busy={false} submit={vi.fn()} productKey="PR-X" />);

  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("bez obrázka")).toBeDefined();
});

it("PanelCandidateRow: text ukazuje meno, URL aj '(kód sedí)' len keď codeHit je true", () => {
  const { unmount } = render(<PanelCandidateRow candidate={CANDIDATE} index={0} busy={false} submit={vi.fn()} productKey="PR-X" />);
  expect(screen.getByText(/Top kandidát/).textContent).toContain("(kód sedí)");
  unmount();

  render(<PanelCandidateRow candidate={{ ...CANDIDATE, codeHit: false }} index={0} busy={false} submit={vi.fn()} productKey="PR-X" />);
  expect(screen.getByText(/Top kandidát/).textContent).not.toContain("(kód sedí)");
});

it("PanelCandidateRow: busy=true disabluje tlačidlo 'Vybrať'", () => {
  render(<PanelCandidateRow candidate={CANDIDATE} index={0} busy={true} submit={vi.fn()} productKey="PR-X" />);
  expect(screen.getByTestId<HTMLButtonElement>("pairing-review-panel-pick-PR-X-0").disabled).toBe(true);
});
