import { describe, expect, it } from "vitest";
import { resolveMailSender } from "./transport.js";

// issue 358: majiteľ zistil, že e-maily zákazníkom odchádzajú z
// info@forestshop.sk namiesto eshop@forestshop.sk, a appka doteraz vôbec
// nenastavovala Reply-To. `resolveMailSender` je čistá funkcia (žiadny SMTP)
// vytiahnutá z `createSmtpMailTransport`, aby sa dala otestovať bez
// bežiaceho servera — presne rovnaké odvodenie, aké appka použije pri
// KAŽDOM odoslaní zákazníkovi.
describe("resolveMailSender", () => {
  it("from: použije explicitný config.from, keď je nastavený", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      user: "info@forestshop.sk",
      from: "eshop@forestshop.sk",
    });
    expect(from).toBe("eshop@forestshop.sk");
  });

  it("from: bez config.from spadne späť na SMTP účet (user)", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      user: "info@forestshop.sk",
    });
    expect(from).toBe("info@forestshop.sk");
  });

  it("from: bez config.from AJ bez user spadne späť na host", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
    });
    expect(from).toBe("mbox.myshoptet.com");
  });

  it("replyTo: použije explicitný config.replyTo, NEZÁVISLE od from", () => {
    // issue 358, bod 2: Reply-To musí ostať eshop@forestshop.sk aj keby sa
    // odosielateľ (From) v budúcnosti zmenil na niečo iné — preto je
    // replyTo VLASTNÁ hodnota, nikdy odvodená z from, keď je nastavená.
    const { from, replyTo } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: "novy-odosielatel@forestshop.sk",
      replyTo: "eshop@forestshop.sk",
    });
    expect(from).toBe("novy-odosielatel@forestshop.sk");
    expect(replyTo).toBe("eshop@forestshop.sk");
  });

  it("replyTo: bez config.replyTo spadne späť na rovnakú hodnotu ako from (appka nikdy nepošle mail bez Reply-To)", () => {
    const { from, replyTo } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: "eshop@forestshop.sk",
    });
    expect(replyTo).toBe(from);
    expect(replyTo).toBe("eshop@forestshop.sk");
  });
});
