import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { hashToken } from "./sessions.js";

export type ChangePasswordResult = "ok" | "wrong_old_password";

export interface ChangePasswordInput {
  readonly userId: string;
  readonly oldPassword: string;
  readonly newPassword: string;
  // Token (not hash) of the session making this request — kept alive while every
  // OTHER session of this user is invalidated (#10's "old session stops working"
  // requirement only applies to sessions other than the one performing the change).
  readonly currentSessionToken: string;
  readonly now: Date;
}

// Celý zápis beží v JEDNEJ transakcii (rovnaký vzor ako `catalog/ingest.ts` a
// `scheduler/scheduler.ts`) — pád procesu medzi UPDATE hesla a zrušením
// ostatných relácií by inak mohol nechať nové heslo platné, ale staré
// (ukradnuté?) relácie stále živé, alebo naopak zapísať audit bez toho, aby sa
// heslo skutočne zmenilo.
export async function changePassword(
  db: Database,
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
    // `userId` prichádza z už vyriešenej relácie (`requireUser`) — chýbajúci
    // používateľ by znamenal databázovú nekonzistenciu, nie bežný vstup od
    // klienta. Zaobchádzame s ním rovnako ako so zlým starým heslom (žiadny
    // zápis, žiadny audit s neexistujúcim actorUserId), namiesto vyhodenia.
    if (user === undefined) return "wrong_old_password";

    const oldPasswordOk = await verifyPassword(user.passwordHash, input.oldPassword);
    if (!oldPasswordOk) {
      await record(tx, {
        actorUserId: user.id,
        action: "password.change.failed",
        entity: "user",
        entityId: user.id,
        at: input.now,
      });
      return "wrong_old_password";
    }

    const newPasswordHash = await hashPassword(input.newPassword);
    await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.id));

    const currentTokenHash = hashToken(input.currentSessionToken);
    await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, currentTokenHash)));

    await record(tx, {
      actorUserId: user.id,
      action: "password.change.ok",
      entity: "user",
      entityId: user.id,
      at: input.now,
    });
    return "ok";
  });
}
