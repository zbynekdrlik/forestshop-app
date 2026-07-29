import { hash, verify } from "@node-rs/argon2";

const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Neexistoval nikde v repe skutočný spodný limit dĺžky hesla — loginova
// `z.string().min(1)` kontroluje len neprázdnosť. Toto je prvé miesto, kde
// heslo VOLÍ používateľ sám (#10, zmena vlastného hesla), takže potrebuje
// vlastné, zmysluplné minimum.
export const MIN_NEW_PASSWORD_LENGTH = 8;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, OPTIONS);
  } catch {
    return false;
  }
}
