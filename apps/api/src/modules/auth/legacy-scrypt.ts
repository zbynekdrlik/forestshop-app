import type { ScryptOptions } from "node:crypto";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// `promisify(scrypt)` stratí preťaženie s parametrami, preto vlastný obal.
function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// Stará appka (parovanie_produktov, Flask) ukladá heslá cez werkzeug
// `generate_password_hash`, ktorý pri scrypte zapisuje tvar
//
//     scrypt:N:r:p$sol$odtlacokVHexe
//
// kde soľ je obyčajný text (nie hex ani base64) a odtlačok má vždy 64 bajtov.
// Novú appku sme prepli na argon2id, takže tieto odtlačky sa nedajú overiť
// štandardnou cestou — a prepočítať ich na argon2id nejde, odtlačok je
// jednosmerný. Aby zamestnanci pri prechode na novú appku nemuseli meniť
// heslá, vieme ich starý odtlačok overiť aj tu; pri prvom úspešnom prihlásení
// sa potom prepíše na argon2id (viď `login` v service.ts).
const KEY_LENGTH_BYTES = 64;

// Werkzeug používa N=32768, r=8, p=1. Parametre síce čítame z odtlačku, ale
// obmedzíme ich zhora, aby poškodený alebo podvrhnutý riadok v databáze
// nedokázal vyžiadať scrypt s absurdnou pamäťovou náročnosťou.
// Limity sú zámerne tesné: scrypt si vyžiada 128 * N * r bajtov, takže pri
// týchto stropoch je najhorší prípad ~268 MB namiesto niekoľkých gigabajtov.
const MAX_COST = 1 << 17;
const MAX_BLOCK_SIZE = 16;
const MAX_PARALLELIZATION = 16;

export interface LegacyScryptHash {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly salt: string;
  readonly derivedKeyHex: string;
}

export function isLegacyScryptHash(passwordHash: string): boolean {
  return passwordHash.startsWith("scrypt:");
}

function parsePositiveInt(text: string, max: number): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return null;
  return value;
}

export function parseLegacyScryptHash(passwordHash: string): LegacyScryptHash | null {
  const parts = passwordHash.split("$");
  if (parts.length !== 3) return null;
  const [method, salt, derivedKeyHex] = parts as [string, string, string];

  const methodParts = method.split(":");
  if (methodParts.length !== 4) return null;
  const [name, costText, blockSizeText, parallelizationText] = methodParts as [
    string,
    string,
    string,
    string,
  ];
  if (name !== "scrypt") return null;

  const cost = parsePositiveInt(costText, MAX_COST);
  const blockSize = parsePositiveInt(blockSizeText, MAX_BLOCK_SIZE);
  const parallelization = parsePositiveInt(parallelizationText, MAX_PARALLELIZATION);
  if (cost === null || blockSize === null || parallelization === null) return null;
  // scrypt vyžaduje, aby N bola mocnina dvojky väčšia ako 1.
  if ((cost & (cost - 1)) !== 0 || cost < 2) return null;

  if (salt === "") return null;
  if (derivedKeyHex.length !== KEY_LENGTH_BYTES * 2 || !/^[0-9a-f]+$/i.test(derivedKeyHex)) {
    return null;
  }

  return { cost, blockSize, parallelization, salt, derivedKeyHex };
}

async function deriveKey(
  plain: string,
  parsed: Pick<LegacyScryptHash, "cost" | "blockSize" | "parallelization" | "salt">,
): Promise<Buffer> {
  // Node vyhlási chybu, keď 128 * N * r prekročí `maxmem`. Pri werkzeug
  // parametroch to vyjde presne na predvolených 32 MiB, čo je na hrane —
  // preto si limit nastavíme s rezervou sami.
  const maxmem = 256 * parsed.cost * parsed.blockSize + 32 * 1024 * 1024;
  return scryptAsync(plain, parsed.salt, KEY_LENGTH_BYTES, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelization,
    maxmem,
  });
}

export async function verifyLegacyScryptPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  const parsed = parseLegacyScryptHash(passwordHash);
  if (parsed === null) return false;
  try {
    const derived = await deriveKey(plain, parsed);
    const expected = Buffer.from(parsed.derivedKeyHex, "hex");
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Používa sa LEN v testoch a pri overovaní nasadenia — vyrobí odtlačok v
// rovnakom tvare, aký píše werkzeug, aby sa dala otestovať celá cesta bez
// jediného skutočného hesla zamestnanca.
export async function createLegacyScryptHash(plain: string): Promise<string> {
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const salt = randomBytes(12).toString("base64url").slice(0, 16);
  const derived = await deriveKey(plain, { cost, blockSize, parallelization, salt });
  const method = `scrypt:${String(cost)}:${String(blockSize)}:${String(parallelization)}`;
  return `${method}$${salt}$${derived.toString("hex")}`;
}
