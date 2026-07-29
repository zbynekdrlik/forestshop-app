import { createHash, randomBytes } from "node:crypto";
import { lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { sessions } from "../../db/schema.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Expirované relácie sa dnes nemažú vôbec (#3) — `resolveSession` ich správne
// odfiltruje (`expires_at > now`), takže bezpečnostný dopad nie je, ale
// tabuľka rastie donekonečna a hashe starých tokenov v nej zostávajú natrvalo.
// `lte` (nie `lt`), aby hranica presne zodpovedala `resolveSession`'s `gt`:
// relácia s `expires_at` presne rovným `now` je pre `resolveSession` už
// neplatná (`gt` vyžaduje ostro väčšie), takže musí byť "expirovaná" aj tu —
// inak by cleanup nikdy nedobehol práve tie relácie, ktoré vypršali presne v
// momente behu úlohy.
// `.returning()` namiesto spoliehania sa na driverov `rowCount` — rovnaký
// vzor, akým `pruneRawSnapshots` (raw-store.ts) počíta zmazané riadky, a
// funguje nezávisle od toho, ktorý pg driver/verzia je pod drizzle.
export async function cleanupExpiredSessions(
  db: Database,
  now: Date,
): Promise<{ readonly deletedCount: number }> {
  const deleted = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ tokenHash: sessions.tokenHash });
  return { deletedCount: deleted.length };
}
