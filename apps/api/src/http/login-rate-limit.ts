import type { Context } from "hono";

// Malý in-process fixed-window limiter pre POST /api/login. Bráni hrubej sile
// aj lacnému DoS cez opakovaný drahý argon2 verify. Dve nezávislé dimenzie:
//   - (klientska IP, zadaný e-mail) — chráni JEDEN účet pred bušením z mnohých
//     IP adries (distribuovaný útok na cieľ).
//   - samotná IP — chráni pred sprejovaním JEDNÉHO hesla naprieč mnohými (aj
//     neexistujúcimi) e-mailmi z jednej adresy; bez tejto dimenzie by každý
//     nový e-mail dostal vlastné čerstvé okno a spray by nebol nijako
//     limitovaný.
// Obe mapy majú horný strop počtu záznamov (MAX_ENTRIES) — bez neho by útočník
// meniaci e-mail (alebo predstierajúci rôzne IP cez sfalšovanú hlavičku) mohol
// neobmedzene rásť pamäť. Beží len v pamäti jedného procesu: reštart API ho
// vynuluje, čo je pri jednej bežiacej inštancii (MVP rozsah) prijateľné —
// žiadny zdieľaný store medzi inštanciami.
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10; // na (IP, e-mail) pár

// Vyššia hranica než pri (IP, e-mail) páre — bežné použitie (viac ľudí za
// NATom/kanceláriou, zopár preklepov v hesle) nesmie nikdy naraziť LEN na
// tento druhý, širší limit.
const IP_WINDOW_MS = 5 * 60 * 1000;
// Predvolená PRODUKČNÁ hodnota. Prepísať sa dá len premennou prostredia, ktorú
// produkcia nenastavuje — slúži VÝHRADNE pre E2E balík (`playwright.config
// .ts`), kde všetkých ~30 prihlásení celého behu prichádza z JEDNEJ adresy
// (localhost), takže by tento limit narazil zo svojej podstaty, nie kvôli
// útoku. Znižovať/rušiť ochranu v produkcii to nijako neumožňuje: bez
// premennej platí 30, a limit na (IP, e-mail) pár (`MAX_ATTEMPTS`) — ten, čo
// chráni konkrétny účet — sa nemení vôbec.
const IP_MAX_ATTEMPTS = readPositiveIntEnv("LOGIN_IP_MAX_ATTEMPTS", 30); // na samotnú IP, bez ohľadu na e-mail

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_ENTRIES = 10_000; // strop na počet záznamov v KAŽDEJ z dvoch máp
// Pri dosiahnutí stropu sa naraz uvoľní táto dávka miesta zmazaním najskôr
// vypršiavajúcich (= najstarších) záznamov — nie len jedného, aby sa mapa
// nemusela preusporadúvať pri každej ďalšej požiadavke.
const EVICT_BATCH = 100;

// Sweep expirovaných záznamov NEBEŽÍ na `setInterval`/globálnom `Date.now()`
// (to by bežalo aj mimo obsluhy požiadaviek a nedalo by sa deterministicky
// otestovať so simulovaným časom) — namiesto toho sa spustí najviac raz za
// SWEEP_INTERVAL_MS (reálneho) času pri volaní `checkLoginRateLimit`, viazaný
// na `now`, ktoré si volajúci (app.ts) aj tak odovzdáva.
const SWEEP_INTERVAL_MS = 60 * 1000;

interface Window {
  count: number;
  resetAt: number;
}

const pairWindows = new Map<string, Window>();
const ipWindows = new Map<string, Window>();
let lastSweepAtMs = 0;

function pairKeyFor(ip: string, email: string): string {
  return `${ip} ${email.trim().toLowerCase()}`;
}

// Klientska IP z hlavičiek, ktoré nastavuje Cloudflare tunel pred aplikáciou
// (cf-connecting-ip, prípadne x-forwarded-for). Bez proxy pred appkou (napr.
// v testoch) sa vráti "unknown" — vtedy sa všetky takéto požiadavky delia o
// jeden IP-kľúč, čo je bezpečný, len konzervatívnejší fallback.
export function clientIp(c: Context): string {
  const forwarded = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : "unknown";
}

function sweepExpired(map: Map<string, Window>, nowMs: number): void {
  for (const [key, window] of map) {
    if (nowMs >= window.resetAt) {
      map.delete(key);
    }
  }
}

// Zmaže EVICT_BATCH najskôr vypršiavajúcich záznamov, keď je mapa plná. Keďže
// každé okno má rovnakú dĺžku, najskôr vypršiavajúci resetAt = najstarší
// vytvorený záznam — takže toto je zároveň LRU podľa veku.
function evictOldestIfFull(map: Map<string, Window>): void {
  if (map.size < MAX_ENTRIES) {
    return;
  }
  const oldest = [...map.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, EVICT_BATCH);
  for (const [key] of oldest) {
    map.delete(key);
  }
}

function maintain(nowMs: number): void {
  if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepAtMs = nowMs;
  sweepExpired(pairWindows, nowMs);
  sweepExpired(ipWindows, nowMs);
}

/** `true` = počítadlo v limite, `false` = okno je vyčerpané (limit+1. a ďalší pokus). */
function checkWindow(
  map: Map<string, Window>,
  key: string,
  nowMs: number,
  windowMs: number,
  maxAttempts: number,
): boolean {
  const existing = map.get(key);
  if (existing === undefined || nowMs >= existing.resetAt) {
    if (existing === undefined) {
      evictOldestIfFull(map);
    }
    map.set(key, { count: 1, resetAt: nowMs + windowMs });
    return true;
  }
  existing.count += 1;
  return existing.count <= maxAttempts;
}

/** `true` = požiadavka smie prejsť, `false` = niektorý z limitov je prekročený. */
export function checkLoginRateLimit(ip: string, email: string, now: Date): boolean {
  const nowMs = now.getTime();
  maintain(nowMs);
  // Oba kontroly sa musia vyhodnotiť VŽDY (nie cez `&&` so skratovým
  // vyhodnotením) — inak by sa pri zásahu (IP, e-mail) limitu neinkrementoval
  // aj samostatný IP limit, a naopak.
  const pairOk = checkWindow(pairWindows, pairKeyFor(ip, email), nowMs, WINDOW_MS, MAX_ATTEMPTS);
  const ipOk = checkWindow(ipWindows, ip, nowMs, IP_WINDOW_MS, IP_MAX_ATTEMPTS);
  return pairOk && ipOk;
}

/** Testovacia pomôcka — vyprázdni stav, aby sa testy navzájom neovplyvňovali. */
export function resetLoginRateLimit(): void {
  pairWindows.clear();
  ipWindows.clear();
  lastSweepAtMs = 0;
}

/** Testovacia pomôcka — počet záznamov v oboch mapách, na overenie stropu. */
export function rateLimitEntryCountsForTest(): { pair: number; ip: number } {
  return { pair: pairWindows.size, ip: ipWindows.size };
}
