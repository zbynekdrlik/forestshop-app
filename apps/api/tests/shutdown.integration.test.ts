import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client.js";
import { createShutdownHandler } from "../src/shutdown.js";

// issue 78: appka nemala žiadny SIGTERM/SIGINT handler — v produkčnom
// kontajneri (Dockerfile's CMD beží ako PID 1, bez init procesu ako tini)
// preto proces signál ÚPLNE ignoroval (jadro pre PID 1 neaplikuje default
// dispozíciu signálu, pokiaľ nie je explicitne zaregistrovaný handler) a bežal
// ďalej celý stop_grace_period, kým ho Docker nezabil SIGKILLom. Medzitým
// `docker compose up`'s "Recreate" krok stihol interne pripraviť "nahradiť
// starý kontajner" podľa jeho dočasného ID, ale kontajner bol už `destroy`nutý
// — odtiaľ "No such container" (deploy run 30576765525, merge sha
// d19f8eae — skrátené, plný sha je v issue 78). Tieto testy overujú, že
// `createShutdownHandler` naozaj zavrie HTTP server aj DB pool a ukončí
// proces (cez injektovaný `exit`, aby test runner sám neumrel) — v produkcii
// by teda signál viedol na rýchle a čisté ukončenie namiesto 10s čakania na
// SIGKILL.

describe("createShutdownHandler", () => {
  let server: Server | undefined;
  let poolEnd: (() => Promise<void>) | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await poolEnd?.().catch(() => undefined);
    server = undefined;
    poolEnd = undefined;
  });

  it("zavrie HTTP server aj DB pool a ukončí proces s kódom 0", async () => {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url === "") {
      throw new Error("Integračné testy potrebujú DATABASE_URL na testovaciu databázu");
    }
    const { pool } = createDb(url);
    poolEnd = () => pool.end();

    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server?.listen(0, resolve));

    const exit = vi.fn<(code: number) => void>();
    const handler = createShutdownHandler({ server, pool, exit });

    handler("SIGTERM");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });

    expect(server.listening).toBe(false);
    // pool.end() bol skutočne zavolaný — ďalší dopyt na zatvorenom pool-e musí zlyhať
    await expect(pool.query("select 1")).rejects.toThrow();
    poolEnd = undefined; // pool je už zatvorený, druhé .end() by zlyhalo
  });

  it("ignoruje druhý signál, kým prebieha shutdown (idempotencia)", async () => {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url === "") {
      throw new Error("Integračné testy potrebujú DATABASE_URL na testovaciu databázu");
    }
    const { pool } = createDb(url);
    poolEnd = () => pool.end();

    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server?.listen(0, resolve));

    const exit = vi.fn<(code: number) => void>();
    const handler = createShutdownHandler({ server, pool, exit });

    handler("SIGTERM");
    handler("SIGTERM"); // druhé volanie počas prebiehajúceho shutdownu — musí byť no-op

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    poolEnd = undefined;
  });

  it("vynúti exit(1), keď sa server.close() nestihne skončiť včas", async () => {
    const neverClosingServer = {
      close: () => {
        // zámerne nikdy nezavolá callback — simuluje zaseknuté keep-alive spojenie
      },
    };
    const neverEndingPool = { end: () => new Promise<void>(() => undefined) };
    const exit = vi.fn<(code: number) => void>();

    const handler = createShutdownHandler({
      server: neverClosingServer,
      pool: neverEndingPool,
      exit,
      forceExitAfterMs: 50,
    });

    handler("SIGTERM");

    await vi.waitFor(
      () => {
        expect(exit).toHaveBeenCalledWith(1);
      },
      { timeout: 2000 },
    );
  });
});
