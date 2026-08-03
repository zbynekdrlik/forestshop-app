import { hash, verify } from "@node-rs/argon2";
import { isLegacyScryptHash, verifyLegacyScryptPassword } from "./legacy-scrypt.js";

const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Neexistoval nikde v repe skutočný spodný limit dĺžky hesla — loginova
// `z.string().min(1)` kontroluje len neprázdnosť. Toto je prvé miesto, kde
// heslo VOLÍ používateľ sám (#10, zmena vlastného hesla), takže potrebuje
// vlastné, zmysluplné minimum.
export const MIN_NEW_PASSWORD_LENGTH = 8;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

// Účty prenesené zo starej appky (#189) majú odtlačok ešte vo werkzeug
// scrypt tvare. Overíme ho starou cestou, aby zamestnanci nemuseli meniť
// heslá; `login` ho po prvom úspešnom prihlásení prepíše na argon2id.
export function needsRehash(passwordHash: string): boolean {
  return isLegacyScryptHash(passwordHash);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  if (isLegacyScryptHash(passwordHash)) {
    return verifyLegacyScryptPassword(passwordHash, plain);
  }
  try {
    return await verify(passwordHash, plain, OPTIONS);
  } catch {
    return false;
  }
}
