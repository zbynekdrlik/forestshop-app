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
}

export interface ShutdownPool {
  end: () => Promise<void>;
}

export interface ShutdownDeps {
  server: ShutdownServer;
  pool: ShutdownPool;
  /** Bounded fallback — force-exit ak sa graceful cesta nestihne včas (default 8s). */
  forceExitAfterMs?: number;
  /** Injektovateľné pre testy — reálny default volá process.exit(). */
  exit?: (code: number) => void;
}

export function createShutdownHandler({
  server,
  pool,
  forceExitAfterMs = 8000,
  exit = (code: number) => process.exit(code),
}: ShutdownDeps): (signal: NodeJS.Signals) => void {
  let shuttingDown = false;

  return (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.debug({ signal }, "shutdown už prebieha — ďalší signál ignorovaný");
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "prijatý ukončovací signál — spúšťam graceful shutdown");

    const forceTimer = setTimeout(() => {
      log.error(
        { signal, forceExitAfterMs },
        "graceful shutdown neskončil včas — vynútený exit(1)",
      );
      exit(1);
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
          exit(0);
        })
        .catch((poolErr: unknown) => {
          log.error({ err: poolErr }, "chyba pri zatváraní DB poolu počas shutdownu");
          clearTimeout(forceTimer);
          exit(1);
        });
    });
  };
}
