import { KONTAKT_EMAIL, KONTAKT_TELEFON, WEB_FORESTSHOP, WEB_FORESTSHOP_LABEL } from "./context.js";

// issue 347 — majiteľ: e-maily zákazníkom vyzerali "hrozne" (holá adresa ako
// text odkazu, žiadny obrázok, telefón/e-mail stratené vo vete). Táto jedna
// zdieľaná kostra (hlavička + pätička s KONTAKTAMI oddelenými od tela) sa
// vkladá okolo obsahu KAŽDEJ šablóny — šablóny (`registry.ts`) do nej vkladajú
// len svoj obsah, kostra sa needituje. Volaná z DVOCH vykresľovacích miest
// (`assembleHtml` cez `renderTemplate`, `renderEditedBody`), takže platí pre
// každý e-mail appky bez toho, aby si to musel pamätať každý odosielateľ.
// `orders/mail.ts`'s `supplier_order` (jediný ČISTO TEXTOVÝ e-mail,
// `.claude/rules/mail-templates.md`) sem nikdy nepríde — posiela výhradne
// `.text`, `assembleHtml`/`wrapEmailHtml` sa naň nikdy nepozerá.
//
// `KONTAKT_TELEFON`/`KONTAKT_EMAIL`/`WEB_FORESTSHOP` sú TIE ISTÉ hodnoty, aké
// dostanú `{{kontakt_telefon}}`/`{{kontakt_email}}`/`{{web_forestshop}}` v
// tele šablóny (`context.ts`) — pätička nikdy nemôže obsahovať iný telefón/
// e-mail, než aký appka ponúka ako zástupné pole.

const BRAND = "#2f5233";
const TEL_HREF = `tel:${KONTAKT_TELEFON.replaceAll(" ", "")}`;

export function wrapEmailHtml(bodyHtml: string): string {
  return [
    "<!DOCTYPE html>",
    "<html>",
    '  <body style="margin:0;padding:24px 12px;background:#f4f1ec;font-family: Arial, sans-serif;">',
    '    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">',
    `      <tr><td style="padding:18px 32px;background:${BRAND};">`,
    `        <a href="${WEB_FORESTSHOP}" style="font-size:20px;font-weight:bold;color:#ffffff;text-decoration:none;">Forestshop.sk</a>`,
    "      </td></tr>",
    '      <tr><td style="padding:28px 32px;font-size:16px;color:#333;">',
    bodyHtml,
    "      </td></tr>",
    '      <tr><td style="padding:20px 32px;border-top:1px solid #e5e0d8;font-size:13px;color:#666;">',
    `        <div style="margin-bottom:4px;">Tel.: <a href="${TEL_HREF}" style="color:${BRAND};text-decoration:none;">${KONTAKT_TELEFON}</a></div>`,
    `        <div style="margin-bottom:4px;">E-mail: <a href="mailto:${KONTAKT_EMAIL}" style="color:${BRAND};text-decoration:none;">${KONTAKT_EMAIL}</a></div>`,
    `        <div><a href="${WEB_FORESTSHOP}" style="color:${BRAND};text-decoration:none;">${WEB_FORESTSHOP_LABEL}</a></div>`,
    "      </td></tr>",
    "    </table>",
    "    </td></tr></table>",
    "  </body>",
    "</html>",
  ].join("\n");
}

// issue 379: textový analóg tej istej pätičky — predtým JESTVOVALA len pre
// HTML (`wrapEmailHtml`), takže čistotextová verzia e-mailu nemala kontakt
// NIKDE potom, čo sa z tela šablóny odstránili opakované vety s
// `{{kontakt_email}}`/`{{kontakt_telefon}}` (issue 379 — kontakt sa NESMIE
// opakovať v tele AJ v pätičke). Volá sa z TOHO ISTÉHO miesta ako
// `wrapEmailHtml` (`render.ts`'s `renderTemplate`/`renderEditedBody`), takže
// platí pre každý zákaznícky e-mail rovnako — OKREM `supplier_order`
// (jediný čisto textový e-mail dodávateľovi, ktorý si toto explicitne
// vypína cez `renderTemplate`'s `{ footer: false }`, `orders/mail.ts`, aby
// ostal bajt na bajt nezmenený, `.claude/rules/mail-templates.md`).
export function wrapEmailText(bodyText: string): string {
  const footer = [`Tel.: ${KONTAKT_TELEFON}`, `E-mail: ${KONTAKT_EMAIL}`, WEB_FORESTSHOP_LABEL].join("\n");
  return bodyText === "" ? footer : `${bodyText}\n\n${footer}`;
}
