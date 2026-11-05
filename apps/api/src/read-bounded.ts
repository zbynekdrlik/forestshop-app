// Ohraničené čítanie tela HTTP odpovede — zdieľané všetkými fetchermi appky
// (pôvodne v `modules/catalog/fetcher.ts`, presunuté v issue 598 na koreňovú
// úroveň `src/` vedľa `timezone.ts`/`logger.ts`, lebo ho potrebuje aj
// `modules/shoptet-http/fetch.ts`, ktorý `catalog/fetcher.ts` sám importuje).

/**
 * Číta telo odpovede PO ČASTIACH a priebežne sčitáva veľkosť — `Buffer.from(await
 * response.arrayBuffer())` by celé telo najprv bufferovalo bez ohľadu na strop,
 * takže strop kontroluje až PO tom, čo pamäť už bola vyčerpaná. Táto funkcia
 * zruší čítanie (`reader.cancel()`) HNEĎ, ako súčet prekročí strop, a vyhodí
 * bežnú chybu — nikdy nenechá proces spadnúť na pamäť.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  // `Response.body` je (bez `dom` libu, len `@types/node`'s `undici-types`)
  // typovaný ako `ReadableStream` bez generika, teda efektívne
  // `ReadableStream<any>` — cast na `Uint8Array` je bezpečný, `fetch` telo
  // odpovede vždy strieamuje bajty, nikdy nič iné.
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) {
    return Buffer.from(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `Stiahnutý export prekročil povolenú veľkosť ${String(maxBytes)} bajtov — stiahnutie bolo zastavené.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
