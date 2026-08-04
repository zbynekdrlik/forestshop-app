import { describe, expect, it } from "vitest";
import { MAX_PAGE_BYTES } from "./constants.js";

describe("MAX_PAGE_BYTES", () => {
  // issue 224: naživo po nasadení (post-deploy overenie) sa ukázalo, že
  // shop.lasting.eu's BONY produkt má CELÚ stránku 2 180 285 bajtov — takmer
  // výhradne z opakovaného whitespace v PrestaShop šablóne skupiny "Odstín".
  // Veľkostný zoznam (`parseSizeAvailability`) je na stránke AŽ ZA touto
  // skupinou — pôvodný 2 000 000 strop ho odrezával a veľkosť L/XL (presne
  // tá, ktorú má tento ticket dokázať ako "unavailable") zo zoznamu úplne
  // zmizla. Tento test drží strop nad zmeranou realitou, aby sa regresia
  // nevrátila tichým znížením konštanty v budúcnosti.
  it("má rezervu nad naživo zmeranou veľkosťou shop.lasting.eu BONY stránky", () => {
    expect(MAX_PAGE_BYTES).toBeGreaterThan(2_180_285);
  });
});
