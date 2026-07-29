import type { Context, Next } from "hono";

// CSRF obrana pre stavovo-meniace požiadavky nad autentifikovaným cookie
// session-om. SameSite=Lax dnes stačí (žiadny cudzí web nespustí cross-site
// POST s Lax cookie), ale F1 pridá ďalšie takéto endpointy — oplatí sa to mať
// pripravené vopred, kým je to lacné.
//
// Primárne sa kontroluje Sec-Fetch-Site (moderné prehliadače ho posielajú
// vždy pri fetch/XHR); ako fallback pre klientov bez neho sa porovná Origin
// s Host hlavičkou požiadavky — bez potreby akejkoľvek konfigurácie domény.
// Keď nie je k dispozícii ani jedna hlavička (napr. testy, alebo starý
// non-browser klient), požiadavka prejde — nie je čo porovnať.
export function requireSameOrigin() {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite !== undefined) {
      if (secFetchSite === "same-origin" || secFetchSite === "none") {
        await next();
        return undefined;
      }
      return c.json({ error: "Neplatný pôvod požiadavky" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const host = c.req.header("host") ?? "";
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return c.json({ error: "Neplatný pôvod požiadavky" }, 403);
      }
      if (originHost !== host) {
        return c.json({ error: "Neplatný pôvod požiadavky" }, 403);
      }
    }

    await next();
    return undefined;
  };
}
