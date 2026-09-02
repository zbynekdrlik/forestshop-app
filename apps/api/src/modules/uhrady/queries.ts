import { desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { slavosportPaymentNote, slavosportPaymentScan } from "../../db/schema-uhrady.js";
import { users } from "../../db/schema-users.js";

// issue 543: "SLAVOSPORT → Úhrady". ZDIEĽANÝ zoznam (žiadny per-user filter,
// ako `note`/#437): INNER JOIN na `users` pripojí meno AUTORA. Zoradené
// „najnovšie hore".

export interface PaymentNoteRow {
  readonly id: string;
  readonly text: string;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function listPaymentNotes(db: Database): Promise<readonly PaymentNoteRow[]> {
  return db
    .select({
      id: slavosportPaymentNote.id,
      text: slavosportPaymentNote.text,
      authorUserId: slavosportPaymentNote.userId,
      authorName: users.displayName,
      createdAt: slavosportPaymentNote.createdAt,
      updatedAt: slavosportPaymentNote.updatedAt,
    })
    .from(slavosportPaymentNote)
    .innerJoin(users, eq(users.id, slavosportPaymentNote.userId))
    .orderBy(desc(slavosportPaymentNote.createdAt));
}

export interface PaymentScanRow {
  readonly id: string;
  readonly description: string;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// `image` (bytea) sa NIKDY nevyberá do zoznamu — inak by sa poll nafúkol na
// megabajty (lekcia `.claude/rules/daily-tasks.md`). Bajty sa streamujú
// samostatnou trasou `getPaymentScanImage`.
export async function listPaymentScans(db: Database): Promise<readonly PaymentScanRow[]> {
  return db
    .select({
      id: slavosportPaymentScan.id,
      description: slavosportPaymentScan.description,
      authorUserId: slavosportPaymentScan.userId,
      authorName: users.displayName,
      createdAt: slavosportPaymentScan.createdAt,
      updatedAt: slavosportPaymentScan.updatedAt,
    })
    .from(slavosportPaymentScan)
    .innerJoin(users, eq(users.id, slavosportPaymentScan.userId))
    .orderBy(desc(slavosportPaymentScan.createdAt));
}

export interface PaymentScanImage {
  readonly image: Buffer;
  readonly mime: string;
}

// Jeden obrázok na streamovanie (`GET /api/uhrady/scans/:id/image`). Vyberá
// `bytea` + MIME LEN pre tento jeden riadok. `null` = sken neexistuje.
export async function getPaymentScanImage(db: Database, id: string): Promise<PaymentScanImage | null> {
  const [row] = await db
    .select({ image: slavosportPaymentScan.image, mime: slavosportPaymentScan.imageMime })
    .from(slavosportPaymentScan)
    .where(eq(slavosportPaymentScan.id, id));
  if (row === undefined) return null;
  return { image: row.image, mime: row.mime };
}
