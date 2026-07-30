import { log } from "./logger.js";

/**
 * Vytvorí idempotentný SIGTERM/SIGINT handler pre graceful shutdown appky
 * (issue 78).
 *
 * Prečo toto existuje: appka doteraz nemala ŽIADEN signal handler.
 * `Dockerfile`'s `CMD ["node", "apps/api/dist/index.js"]` beží bez init
 * procesu (žiadny `tini`/`docker compose`'s `init: true`), takže appka je v
 * kontajneri PID 1 — a Linux jadro pre PID 1 NEAPLIKUJE default dispozíciu
 * signálu (SIG_DFL), pokiaľ proces sám nezaregistruje explicitný handler.
 * Appka preto SIGTERM úplne ignorovala, bežala ďalej celý
 * `stop_grace_period` (Docker default 10s), kým ju Docker nezabil SIGKILLom.
 * Medzitým `docker compose up`'s "Recreate" krok stihol interne pripraviť
 * "nahradiť starý kontajner" podľa jeho dočasného ID, ale kontajner bol už
 * `destroy`nutý (SIGKILL → die → destroy) skôr, než sa k tomu kroku dostal —
 * odtiaľ "No such container" pri deployi. Explicitný handler (táto funkcia)
 * obchádza PID-1 problém úplne: signál sa VŽDY doručí zaregistrovanému JS
 * handleru bez ohľadu na to, či proces beží ako PID 1.
 */

export interface ShutdownServer {
  close: (callback: (err?: Error) => void) => void;
  /** Voliteľné — reálny http.Server ju má (Node 18.2+), testovacie fake objekty nemusia. */
  closeIdleConnections?: () => void;
}

export interface ShutdownPool {
  end: () => Promise<void>;
}

export interface ShutdownScheduler {
  stop: () => void;
}

export interface ShutdownDeps {
  server: ShutdownServer;
  pool: ShutdownPool;
  /**
   * Voliteľné — keď appka beží aj s naplánovanými úlohami (`startScheduler()`),
   * `.stop()` sa zavolá HNEĎ na začiatku shutdownu, aby počas neho nezačal
   * nový tick (issue 78 review, finding 1: appka bez tohto rizikovala, že
   * `pool.end()` bude čakať na DB klienta vzatého rozbehnutou úlohou).
   * `.stop()` len zruší budúci `setInterval` tick — UŽ bežiacu úlohu
   * neprerušuje, tá sa dobehne (alebo ju odreže force-exit fallback).
   */
  scheduler?: ShutdownScheduler;
  /** Bounded fallback — force-exit ak sa graceful cesta nestihne včas (default 8s). */
  forceExitAfterMs?: number;
  /** Injektovateľné pre testy — reálny default volá process.exit(). */
  exit?: (code: number) => void;
}

export function createShutdownHandler({
  server,
  pool,
  scheduler,
  forceExitAfterMs = 8000,
  exit = (code: number) => process.exit(code),
}: ShutdownDeps): (signal: NodeJS.Signals) => void {
  let shuttingDown = false;
  // Chráni pred DVOJITÝM zavolaním `exit()` — force-exit timer aj graceful
  // cesta (server.close → pool.end) mohli by teoreticky obe dobehnúť (napr.
  // force timer vystrelí exit(1), a tesne nato sa aj pomalé pool.end()
  // vyrieši a zavolá exit(0)). V produkcii je to neškodné (reálny
  // process.exit() proces okamžite ukončí, žiadny ďalší JS kód sa nespustí),
  // ale injektovaný `exit` v testoch NEukončuje nič — bez tejto stráže by ho
  // teda šlo zavolať dvakrát s rôznym kódom.
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) {
      return;
    }
    exited = true;
    exit(code);
  };

  return (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.debug({ signal }, "shutdown už prebieha — ďalší signál ignorovaný");
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "prijatý ukončovací signál — spúšťam graceful shutdown");

    if (scheduler) {
      scheduler.stop();
      log.info("plánovač zastavený — žiadny nový tick sa už nespustí");
    }
    // Nečaká na callback (na rozdiel od server.close() nižšie) — len urýchli
    // bežný prípad (žiadne aktívne spojenia), aby server.close() nemusel
    // čakať na idle keep-alive sokety a nespoliehal sa len na force-exit.
    server.closeIdleConnections?.();

    const forceTimer = setTimeout(() => {
      log.error(
        { signal, forceExitAfterMs },
        "graceful shutdown neskončil včas — vynútený exit(1)",
      );
      exitOnce(1);
    }, forceExitAfterMs);
    forceTimer.unref();

    server.close((err) => {
      if (err) {
        log.error({ err }, "chyba pri zatváraní HTTP servera počas shutdownu");
      } else {
        log.info("HTTP server prestal prijímať nové spojenia");
      }

      pool
        .end()
        .then(() => {
          log.info("DB pool zatvorený — shutdown dokončený");
          clearTimeout(forceTimer);
          exitOnce(0);
        })
        .catch((poolErr: unknown) => {
          log.error({ err: poolErr }, "chyba pri zatváraní DB poolu počas shutdownu");
          clearTimeout(forceTimer);
          exitOnce(1);
        });
    });
  };
}
