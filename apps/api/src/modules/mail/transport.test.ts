import { describe, expect, it } from "vitest";
import { resolveMailSender } from "./transport.js";

// issue 358: majiteľ zistil, že e-maily zákazníkom odchádzajú z
// info@forestshop.sk namiesto eshop@forestshop.sk, a appka doteraz vôbec
// nenastavovala Reply-To. `resolveMailSender` je čistá funkcia (žiadny SMTP)
// vytiahnutá z `createSmtpMailTransport`, aby sa dala otestovať bez
// bežiaceho servera — presne rovnaké odvodenie, aké appka použije pri
// KAŽDOM odoslaní zákazníkovi.
//
// issue 433: e-maily odchádzali s menom odosielateľa „eshop" (lokálna časť
// holej adresy), lebo `resolveMailSender` skladala `from` ako holý string
// bez display mena. Poistka: holá adresa (bez `<`) sa obalí defaultným
// display menom „Forestshop.sk" → `"Forestshop.sk" <adresa>`; string, čo už
// display meno má (obsahuje `<`), sa prenesie BEZ zmeny. Platí pre celú
// fallback reťaz `config.from ?? config.user ?? config.host`.
describe("resolveMailSender", () => {
  it("from: holú explicitnú config.from adresu obalí defaultným display menom „Forestshop.sk\"", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      user: "info@forestshop.sk",
      from: "eshop@forestshop.sk",
    });
    expect(from).toBe('"Forestshop.sk" <eshop@forestshop.sk>');
  });

  it("from: bez config.from spadne späť na SMTP účet (user) a TIEŽ ho obalí", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      user: "info@forestshop.sk",
    });
    expect(from).toBe('"Forestshop.sk" <info@forestshop.sk>');
  });

  it("from: bez config.from AJ bez user spadne späť na host a TIEŽ ho obalí", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
    });
    expect(from).toBe('"Forestshop.sk" <mbox.myshoptet.com>');
  });

  it("from: keď MAIL_FROM UŽ má display meno (obsahuje `<`), prenesie sa BEZ zmeny", () => {
    // Reálny produkčný `MAIL_FROM=Forestshop.sk <eshop@forestshop.sk>` (14. 8.)
    // — appka nikdy neprepíše explicitne nastavené meno.
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: "Forestshop.sk <eshop@forestshop.sk>",
    });
    expect(from).toBe("Forestshop.sk <eshop@forestshop.sk>");
  });

  it("from: aj už zacitované display meno (`\"Meno\" <adresa>`) sa prenesie BEZ zmeny", () => {
    const { from } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: '"Iné meno" <eshop@forestshop.sk>',
    });
    expect(from).toBe('"Iné meno" <eshop@forestshop.sk>');
  });

  it("replyTo: použije explicitný config.replyTo BEZ obalenia, NEZÁVISLE od from", () => {
    // issue 358, bod 2: Reply-To musí ostať eshop@forestshop.sk aj keby sa
    // odosielateľ (From) v budúcnosti zmenil na niečo iné — preto je
    // replyTo VLASTNÁ hodnota, nikdy odvodená z from, keď je nastavená.
    // issue 433: explicitný Reply-To sa NEobaľuje display menom (obaľuje sa
    // len fallback reťaz `from`), prenáša sa doslovne.
    const { from, replyTo } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: "novy-odosielatel@forestshop.sk",
      replyTo: "eshop@forestshop.sk",
    });
    expect(from).toBe('"Forestshop.sk" <novy-odosielatel@forestshop.sk>');
    expect(replyTo).toBe("eshop@forestshop.sk");
  });

  it("replyTo: bez config.replyTo spadne späť na rovnakú (obalenú) hodnotu ako from (appka nikdy nepošle mail bez Reply-To)", () => {
    const { from, replyTo } = resolveMailSender({
      host: "mbox.myshoptet.com",
      from: "eshop@forestshop.sk",
    });
    expect(replyTo).toBe(from);
    expect(replyTo).toBe('"Forestshop.sk" <eshop@forestshop.sk>');
  });
});
