import pino from "pino";

// Žiadne z volaní log.* v tomto projekte dnes neloguje objekt v tvare
// { req: { headers: … } } ani pole "password" — sú to vlastné ploché objekty
// (requestId/method/path/status/elapsedMs, reason), takže tieto cesty by nikdy
// nič nezakryli. Ak niekedy pribudne log obsahujúci heslo, token, alebo
// cookie hlavičku, PRIDAJ sem jeho presnú cestu — inak zostáva táto
// konfigurácia mŕtva.
export const log = pino({
  level: process.env["LOG_LEVEL"] ?? "debug",
  redact: { paths: ["password", "token", "cookie"], censor: "***" },
});
