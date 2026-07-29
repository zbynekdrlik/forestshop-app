import { z } from "zod";
import { createDb } from "../apps/api/src/db/client.js";
import { users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

const [email, password, displayName, role = "admin"] = process.argv.slice(2);
if (email === undefined || password === undefined || displayName === undefined) {
  throw new Error("Použitie: create-user.ts <email> <heslo> <meno> [rola]");
}
const parsedRole = z.enum(["admin", "manazer", "sef", "citanie"]).parse(role);
const { db, pool } = createDb();
await db.insert(users).values({
  email,
  passwordHash: await hashPassword(password),
  displayName,
  role: parsedRole,
});
await pool.end();
console.log(`Používateľ ${email} založený s rolou ${parsedRole}`);
