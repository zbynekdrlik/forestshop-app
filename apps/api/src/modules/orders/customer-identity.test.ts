import { describe, expect, it } from "vitest";
import { customerIdentityKey } from "./customer-identity.js";

// issue 431/257: zdieľaná identita zákazníka — čistá funkcia (bez DB), preto
// unit test vedľa modulu (rovnaký vzor ako `supplier-key.test.ts`).
describe("customerIdentityKey", () => {
  it("keď je e-mail, kľúčuje podľa neho (orezaný, malé písmená) — meno ignoruje", () => {
    expect(customerIdentityKey("Juraj@Example.SK", "Juraj Petro")).toBe("email:juraj@example.sk");
    expect(customerIdentityKey("  juraj@example.sk  ", "Iné Meno")).toBe("email:juraj@example.sk");
  });

  it("tá istá osoba s rôznym zápisom e-mailu má TEN ISTÝ kľúč", () => {
    expect(customerIdentityKey("A@B.sk", "X")).toBe(customerIdentityKey("a@b.sk", "Y"));
  });

  it("bez e-mailu (null/prázdny) padá späť na meno (orezané, malé písmená)", () => {
    expect(customerIdentityKey(null, "Hosť Bezmail")).toBe("name:hosť bezmail");
    expect(customerIdentityKey("", "  Hosť Bezmail  ")).toBe("name:hosť bezmail");
    expect(customerIdentityKey("   ", "Hosť Bezmail")).toBe("name:hosť bezmail");
  });

  it("dvaja rôzni ľudia bez e-mailu, rôzne meno → rôzny kľúč", () => {
    expect(customerIdentityKey(null, "Anna Nová")).not.toBe(customerIdentityKey(null, "Juraj Petro"));
  });
});
