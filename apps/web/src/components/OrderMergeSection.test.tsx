import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderMergeSection } from "./OrderMergeSection.js";

const { fetchOrderMergeCandidates, fetchOrderMergePreview, sendOrderMergeMail } = vi.hoisted(() => ({
  fetchOrderMergeCandidates: vi.fn(),
  fetchOrderMergePreview: vi.fn(),
  sendOrderMergeMail: vi.fn(),
}));

vi.mock("../orderMergeApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderMergeApi.js")>();
  return { ...actual, fetchOrderMergeCandidates, fetchOrderMergePreview, sendOrderMergeMail };
});

// issue 277: rovnaký "editovateľný náhľad" mechanizmus ako
// `NedostupneSection.test.tsx` — obe cesty zdieľajú `MailPreviewDialog`.

const GROUP = {
  customerName: "Eva Kováčová",
  email: "eva@example.sk",
  orders: [
    { orderId: "order-a", externalOrderId: "27700101", placedAt: "2026-08-01T10:00:00.000Z" },
    { orderId: "order-b", externalOrderId: "27700100", placedAt: "2026-07-31T10:00:00.000Z" },
  ],
};

const LIST_WITH_GROUP = { groups: [GROUP], bccMissing: false, mailNotConfigured: false };
const PREVIEW = { ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "eva@example.sk", customerName: "Eva Kováčová", orderNumbers: ["27700100", "27700101"], previewToken: "tok-1" };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchOrderMergeCandidates.mockResolvedValue({ groups: [], bccMissing: false, mailNotConfigured: false });
  render(<OrderMergeSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-empty");
});

it("klik na 'náhľad' otvorí povinný náhľad — Odoslať sa ešte nevolá, textové pole je predvyplnené z náhľadu", async () => {
  fetchOrderMergeCandidates.mockResolvedValue(LIST_WITH_GROUP);
  fetchOrderMergePreview.mockResolvedValue(PREVIEW);
  render(<OrderMergeSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-group-27700101");

  fireEvent.click(screen.getByTestId("order-merge-send-27700101"));
  await screen.findByTestId("order-merge-preview");
  expect(sendOrderMergeMail).not.toHaveBeenCalled();
  expect((screen.getByTestId("order-merge-preview-body") as HTMLTextAreaElement).value).toBe("Ahoj");
});

it("potvrdenie BEZ úpravy odošle pôvodný predvyplnený text", async () => {
  fetchOrderMergeCandidates.mockResolvedValue(LIST_WITH_GROUP);
  fetchOrderMergePreview.mockResolvedValue(PREVIEW);
  sendOrderMergeMail.mockResolvedValue({ ok: true });
  render(<OrderMergeSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-group-27700101");

  fireEvent.click(screen.getByTestId("order-merge-send-27700101"));
  await screen.findByTestId("order-merge-preview");
  fireEvent.click(screen.getByTestId("order-merge-preview-confirm"));

  await waitFor(() => {
    expect(sendOrderMergeMail).toHaveBeenCalledWith("order-a", ["order-b"], "tok-1", "Ahoj");
  });
});

it("obsluha upraví text v náhľade — odošle sa upravený text, nie pôvodný", async () => {
  fetchOrderMergeCandidates.mockResolvedValue(LIST_WITH_GROUP);
  fetchOrderMergePreview.mockResolvedValue(PREVIEW);
  sendOrderMergeMail.mockResolvedValue({ ok: true });
  render(<OrderMergeSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-group-27700101");

  fireEvent.click(screen.getByTestId("order-merge-send-27700101"));
  await screen.findByTestId("order-merge-preview");
  fireEvent.change(screen.getByTestId("order-merge-preview-body"), { target: { value: "Ahoj Eva, obe objednávky pošleme spolu." } });
  fireEvent.click(screen.getByTestId("order-merge-preview-confirm"));

  await waitFor(() => {
    expect(sendOrderMergeMail).toHaveBeenCalledWith("order-a", ["order-b"], "tok-1", "Ahoj Eva, obe objednávky pošleme spolu.");
  });
});

it("zrušenie náhľadu NEPOŠLE nič", async () => {
  fetchOrderMergeCandidates.mockResolvedValue(LIST_WITH_GROUP);
  fetchOrderMergePreview.mockResolvedValue(PREVIEW);
  render(<OrderMergeSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-group-27700101");

  fireEvent.click(screen.getByTestId("order-merge-send-27700101"));
  await screen.findByTestId("order-merge-preview");
  fireEvent.click(screen.getByTestId("order-merge-preview-cancel"));

  await waitFor(() => {
    expect(screen.queryByTestId("order-merge-preview")).toBeNull();
  });
  expect(sendOrderMergeMail).not.toHaveBeenCalled();
});

it("rola citanie NEVIDÍ tlačidlo odoslania", async () => {
  fetchOrderMergeCandidates.mockResolvedValue(LIST_WITH_GROUP);
  render(<OrderMergeSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("order-merge-group-27700101");
  expect(screen.queryByTestId("order-merge-send-27700101")).toBeNull();
});
