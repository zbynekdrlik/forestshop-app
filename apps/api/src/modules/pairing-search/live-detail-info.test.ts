import { describe, expect, it, vi } from "vitest";
import type { Fetcher } from "./client.js";
import { SearchClient } from "./client.js";
import { createLiveSupplierInfoFetcher } from "./live-detail-info.js";

// issue 422 — orchestrácia (fetch cez SearchClient + dispatch cez adapter +
// per-URL cache) je čistá funkcia, nikdy sa nedotýka skutočnej siete v
// testoch — injektovaný `Fetcher` (rovnaký vzor ako `client.test.ts`).

const WETLAND_HTML = `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"99.00","availability":"https://schema.org/InStock"}}</script>`;

function clientWithFetcher(fetcher: Fetcher): SearchClient {
  return new SearchClient({ fetcher });
}

describe("createLiveSupplierInfoFetcher", () => {
  it("dispatchuje na WETLAND adaptéra pre URL patriacu jeho hostu a vráti extrahovanú metu", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(WETLAND_HTML);
    const fetchInfo = createLiveSupplierInfoFetcher(clientWithFetcher(fetcher));
    const meta = await fetchInfo("https://www.wetland.sk/nohavice/x-1");
    expect(meta).toEqual({ price: "99.00", availabilityText: "Skladom" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("URL mimo troch známych adaptérov vráti prázdnu metu BEZ akéhokoľvek fetchu", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(WETLAND_HTML);
    const fetchInfo = createLiveSupplierInfoFetcher(clientWithFetcher(fetcher));
    const meta = await fetchInfo("https://e2e-dodavatel.example.com/produkt");
    expect(meta).toEqual({ price: null, availabilityText: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("druhé volanie na TÚ ISTÚ URL sa servíruje z cache — fetcher sa zavolá len raz", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(WETLAND_HTML);
    const fetchInfo = createLiveSupplierInfoFetcher(clientWithFetcher(fetcher));
    await fetchInfo("https://www.wetland.sk/nohavice/x-1");
    await fetchInfo("https://www.wetland.sk/nohavice/x-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("zlyhaný fetch (sieťová chyba) degraduje na prázdnu metu, nikdy nevyhodí — a VÝSLEDOK SA TIEŽ CACHUJE (žiadny opakovaný fetch)", async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new Error("timeout"));
    const fetchInfo = createLiveSupplierInfoFetcher(clientWithFetcher(fetcher));
    const meta = await fetchInfo("https://www.wetland.sk/nohavice/x-1");
    expect(meta).toEqual({ price: null, availabilityText: null });
    const again = await fetchInfo("https://www.wetland.sk/nohavice/x-1");
    expect(again).toEqual({ price: null, availabilityText: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dve rôzne inštancie (dve rôzne createApp() volania) majú NEZÁVISLÚ cache", async () => {
    const fetcherA = vi.fn<Fetcher>().mockResolvedValue(WETLAND_HTML);
    const fetcherB = vi.fn<Fetcher>().mockResolvedValue(WETLAND_HTML);
    const fetchInfoA = createLiveSupplierInfoFetcher(clientWithFetcher(fetcherA));
    const fetchInfoB = createLiveSupplierInfoFetcher(clientWithFetcher(fetcherB));
    await fetchInfoA("https://www.wetland.sk/nohavice/x-1");
    await fetchInfoB("https://www.wetland.sk/nohavice/x-1");
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });
});
