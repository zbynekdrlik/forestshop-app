import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 63: ručné priradenie dodávateľa riadku bez dodávateľa. Vydelené z
// `OrdersSection.test.tsx` (rovnaký vzor ako existujúci
// `OrdersSection.ordered.test.tsx` split, `.claude/rules/testing.md`).
//
// issue 89 (review PR 87): predtým žiadny test tejto obrazovky vôbec
// nevolal `assignOrderLineSupplierApi` — tvrdenie, že po zlyhaní netreba nič
// meniť vo frontende, nebolo ničím kryté. Tento súbor dokazuje aj refetch po
// zamietnutí (predtým sa `load()` volalo LEN v úspešnej vetve).

const { fetchOpenOrders, assignOrderLineSupplier } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  assignOrderLineSupplier: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    assignOrderLineSupplier,
  };
});

const LINE_BEZ_DODAVATELA = {
  lineId: "33333333-3333-3333-3333-333333333333",
  orderId: "cccccccc-3333-3333-3333-333333333333",
  externalOrderId: "1003",
  customerName: "Zákazník 3",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1003&src=orders",
  placedAt: "2026-07-20T00:00:00.000Z",
  variantCode: "C-1",
  variantName: "Čiapka FOREST 3001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: true,
  manualSupplierOverride: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// Rovnaký vzor interakcie ako existujúci "manažér nastaví e-mail dodávateľa"
// test vyššie v `OrdersSection.test.tsx` — `fireEvent.change` + KLIK na
// uloženie (nie `keyDown`+Enter).
//
// Pôvodná verzia tohto testu bola preukázateľne krehká, a to DVOMA rôznymi
// pretekmi (obidva nájdené AŽ opakovaným behom, nie na prvý pokus — CI to
// raz skutočne zachytilo na `main`):
// 1) `fireEvent.change` hneď nasledované `fireEvent.keyDown` na TOM ISTOM
//    ťahu — v ~1 z 8 lokálnych behov `saveSupplier()` vôbec nezavolal
//    `onAssignSupplier`. Fix: klik na uložiť tlačidlo namiesto keyDown.
// 2) Skutočná PRÍČINA (`OrderLineRow.tsx`'s efekt na `manualSupplierOverride`
//    bežal aj pri PRVOM mounte, viď jeho komentár) — rýchla interakcia HNEĎ
//    po objavení riadku mohla zachytiť tento oneskorený "reset na ''" AŽ PO
//    napísaní konceptu a ticho ho vymazať (~1 zo ~150 behov). Opravené v
//    `OrderLineRow.tsx` (skip efektu na prvom mounte) — nie workaroundom tu
//    v teste, lebo išlo o skutočný pretek v produkčnom kóde, nie len o
//    krehkú simuláciu interakcie.
async function vyplnAUloz(hodnota: string) {
  const vstup = await screen.findByLabelText<HTMLInputElement>(
    `Priradiť dodávateľa riadku objednávky ${LINE_BEZ_DODAVATELA.externalOrderId} / ${LINE_BEZ_DODAVATELA.variantCode}`,
  );
  // `fireEvent.change` je od RTL synchrónne zabalené v `act()` — hodnota je
  // commitnutá HNEĎ, žiadny `waitFor` (async poll cez `setInterval`) tu
  // netreba a jeho pridanie by len vnieslo zbytočné časové okno.
  fireEvent.change(vstup, { target: { value: hodnota } });
  expect(vstup.value).toBe(hodnota);
  fireEvent.click(
    screen.getByLabelText(
      `Uložiť priradenie dodávateľa riadku objednávky ${LINE_BEZ_DODAVATELA.externalOrderId} / ${LINE_BEZ_DODAVATELA.variantCode}`,
    ),
  );
}

it("úspešné priradenie dodávateľa spraví refetch zoznamu", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "(bez dodávateľa)", lines: [LINE_BEZ_DODAVATELA], email: null },
  ]);
  assignOrderLineSupplier.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);
  await vyplnAUloz("Nový Dodávateľ");

  await waitFor(() => {
    expect(assignOrderLineSupplier).toHaveBeenCalledWith(LINE_BEZ_DODAVATELA.lineId, "Nový Dodávateľ");
  });
  // Počiatočné načítanie + refetch po úspechu.
  await waitFor(() => {
    expect(fetchOpenOrders).toHaveBeenCalledTimes(2);
  });
});

// issue 89 (review PR 87), nález 1: zamietnutie (napr. 409 "Produkt už má
// dodávateľa v katalógu — ručné priradenie nie je možné", keď produkt
// medzitým dostal dodávateľa inou cestou) predtým NErobilo refetch — stará
// verzia zoznamu zostala, vstupné pole na priradenie ostalo viditeľné
// navždy. Teraz sa zoznam obnoví AJ pri zlyhaní, a hláška (nezávislý stav
// `writeFailures`) prežije refetch.
it("zamietnuté priradenie (409) zobrazí slovenskú hlášku A ZÁROVEŇ spraví refetch zoznamu", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "(bez dodávateľa)", lines: [LINE_BEZ_DODAVATELA], email: null },
  ]);
  assignOrderLineSupplier.mockRejectedValue(
    new Error("Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné"),
  );

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);
  await vyplnAUloz("Konkurenčný Zápis");

  // issue 66: kumulatívny banner nahrádza pôvodný jediný `<p role="alert">`.
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "⚠️ Nepodarilo sa uložiť 1 položku×Priradenie dodávateľa — obj. 1003, kód C-1 (Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné)",
    );
  });
  // Počiatočné načítanie + refetch po zlyhaní — samo-vyliečenie stránky,
  // ktorá by inak zostala navždy s neplatným vstupným poľom.
  await waitFor(() => {
    expect(fetchOpenOrders).toHaveBeenCalledTimes(2);
  });
  // Banner prežil refetch (`load()` nemení `writeFailures`, nezávislý stav).
  expect(screen.getByRole("alert").textContent).toBe(
    "⚠️ Nepodarilo sa uložiť 1 položku×Priradenie dodávateľa — obj. 1003, kód C-1 (Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné)",
  );
});

// issue 151: priradenie dodávateľa platí pre CELÝ PRODUKT
// (`supplier-assignment.ts`'s `productSupplierOverrides` kľúčovaná
// `productKey`), takže po uložení cez JEDEN riadok server vráti novú
// `manualSupplierOverride` hodnotu aj pre KAŽDÝ SÚRODENECKÝ riadok toho
// istého produktu (iná veľkosť/objednávka) — nielen pre riadok, čo reálne
// uložil. `assignSupplier` robí PLNÝ refetch po úspechu, takže simulujeme to
// isté: druhý `fetchOpenOrders` návrat nesie NOVÚ `manualSupplierOverride`
// hodnotu na OBOCH riadkoch (presne to, čo by server vrátil pre dva riadky
// toho istého produktu), zatiaľ čo riadok A má stále rozpísaný, ešte
// NEULOŽENÝ koncept.
const LINE_A_SUROD = {
  ...LINE_BEZ_DODAVATELA,
  lineId: "44444444-4444-4444-4444-444444444444",
  orderId: "cccccccc-4444-4444-4444-444444444444",
  externalOrderId: "1004",
  variantCode: "C-2",
};

it("rozpísaný, ešte neuložený koncept priradenia dodávateľa na riadku A PREŽIJE uloženie dodávateľa cez SÚRODENECKÝ riadok B (rovnaký produkt)", async () => {
  fetchOpenOrders.mockResolvedValueOnce([
    {
      supplier: "(bez dodávateľa)",
      lines: [LINE_A_SUROD, LINE_BEZ_DODAVATELA],
      email: null,
    },
  ]);
  assignOrderLineSupplier.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  // Manažér rozpíše koncept na riadku A, ale NEULOŽÍ ho.
  const vstupA = await screen.findByLabelText<HTMLInputElement>(
    `Priradiť dodávateľa riadku objednávky ${LINE_A_SUROD.externalOrderId} / ${LINE_A_SUROD.variantCode}`,
  );
  fireEvent.change(vstupA, { target: { value: "Rozpísaný, ešte neuložený dodávateľ" } });
  expect(vstupA.value).toBe("Rozpísaný, ešte neuložený dodávateľ");

  // Server (po úspešnom uložení cez riadok B) vráti OBIDVA riadky s NOVOU
  // `manualSupplierOverride` hodnotou — presne tak, ako by to spravil
  // skutočný per-produktový override.
  fetchOpenOrders.mockResolvedValueOnce([
    {
      supplier: "Dodávateľ XYZ",
      lines: [
        { ...LINE_A_SUROD, manualSupplierOverride: "Dodávateľ XYZ" },
        { ...LINE_BEZ_DODAVATELA, manualSupplierOverride: "Dodávateľ XYZ" },
      ],
      email: null,
    },
  ]);
  await vyplnAUloz("Dodávateľ XYZ");

  await waitFor(() => {
    expect(assignOrderLineSupplier).toHaveBeenCalledWith(LINE_BEZ_DODAVATELA.lineId, "Dodávateľ XYZ");
  });
  await waitFor(() => {
    expect(fetchOpenOrders).toHaveBeenCalledTimes(2);
  });

  // Riadok A NEBOL uložený — jeho rozpísaný koncept musí PREŽIŤ, nesmie sa
  // ticho prepísať na hodnotu, ktorú práve dostal z refetchu (rovnaký
  // produkt, teda rovnaká `manualSupplierOverride`, ako riadok B, čo reálne
  // uložil).
  //
  // Priradenie dodávateľa MENÍ SKUPINU riadku (`effectiveSupplier` sa zmení
  // z "(bez dodávateľa)" na "Dodávateľ XYZ") — `OrdersSection.tsx`'s
  // `SupplierOrderGroup` má `key={group.supplier}`, takže pôvodná inštancia
  // `OrderLineRow` pre riadok A sa ODMONTUJE a NAMONTUJE sa nová pod novou
  // skupinou. Držať sa STAREJ (`vstupA`) referencie by test urobilo FALOŠNE
  // ZELENÝM — stará, odpojená referencia si ticho drží svoju poslednú
  // hodnotu bez ohľadu na to, čo je aktuálne v DOM-e. Preto sa hodnota číta
  // ZNOVA, cez čerstvý dotaz PO refetchi.
  await waitFor(() => {
    const vstupAPoRefetchi = screen.getByLabelText<HTMLInputElement>(
      `Priradiť dodávateľa riadku objednávky ${LINE_A_SUROD.externalOrderId} / ${LINE_A_SUROD.variantCode}`,
    );
    expect(vstupAPoRefetchi.value).toBe("Rozpísaný, ešte neuložený dodávateľ");
  });
});
