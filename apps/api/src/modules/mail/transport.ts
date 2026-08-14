import nodemailer from "nodemailer";

// Rovnaký MECHANIZMUS ako stará appka (`parovanie_produktov`'s
// `webreview/app.py:1193-1350`, `smtplib`) — obyčajný SMTP, konfigurácia
// výhradne z premenných prostredia, žiadny secret v repe (#31). `nodemailer`
// je Node ekvivalent Pythonovho `smtplib` (investigate-existing-first: SMTP
// protokol sa tu nemá zmysel písať ručne).
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  // issue 172: voliteľné HTML telo — "Nevyzdvihnuté zásielky" posiela
  // formátovaný e-mail zákazníkovi (`text` zostáva jednoduchý fallback,
  // rovnaký ako predtým). Existujúci `sendSupplierOrderMail` ho nikdy
  // nepošle (zostáva čistý text), spätne kompatibilné.
  readonly html?: string;
  // issue 172: skrytá kópia — automatizácia ju posiela VŽDY majiteľovi
  // (fail-closed kontrola žije v `run.ts`, nie tu). Voliteľné, aby existujúce
  // volania (dodávateľská mail) ostali nezmenené.
  readonly bcc?: string;
}

export type MailTransport = (message: MailMessage) => Promise<void>;

export interface SmtpMailConfig {
  readonly host: string;
  readonly port: number;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly from?: string | undefined;
  // issue 358: majiteľ zistil, že odpoveď zákazníka na e-mail appky pristála
  // v inej schránke, než appka v texte sľubuje. ZÁMERNE nezávislé od `from`
  // (nikdy sa z neho neodvodzuje samo) — "aj keby sa odosielateľ (From) v
  // budúcnosti zmenil, Reply-To má ostať rovnaké" (tiket, bod 2). Bez
  // nastavenia spadne späť na `from` (nižšie), appka nikdy nepošle mail bez
  // Reply-To.
  readonly replyTo?: string | undefined;
}

// issue 433: predvolené display meno odosielateľa. Klienti bez neho zobrazia
// lokálnu časť holej adresy („eshop" z eshop@forestshop.sk) — majiteľ chce
// „Forestshop.sk", ako to mala stará n8n cesta.
const DEFAULT_SENDER_DISPLAY_NAME = "Forestshop.sk";

// issue 433: kódová poistka proti regresii „meno odosielateľa = eshop".
// Ak `from` NEOBSAHUJE `<` (holá adresa alebo host), obalíme ho defaultným
// display menom → `"Forestshop.sk" <adresa>` (RFC 5322 quoted-string — bodka
// v mene je tak bezpečná; nodemailer to pošle ako `From: "Forestshop.sk"
// <adresa>`). Ak `from` už display meno má (obsahuje `<`, napr. produkčný
// `MAIL_FROM=Forestshop.sk <eshop@forestshop.sk>`), prenesie sa BEZ zmeny —
// explicitne nastavené meno nikdy neprepisujeme. Bez tejto poistky by sa pri
// budúcej strate/zmene `MAIL_FROM` „eshop" ticho vrátil.
function applyDefaultSenderName(from: string): string {
  if (from.includes("<")) {
    return from;
  }
  return `"${DEFAULT_SENDER_DISPLAY_NAME}" <${from}>`;
}

// Čistá funkcia (žiadny SMTP) — vytiahnutá z `createSmtpMailTransport`, aby
// sa dala unit-testovať bez bežiaceho servera (issue 358).
// Odosielateľ: explicitný `MAIL_FROM`, inak SMTP účet (`user`), inak
// samotný host — appka nikdy nepošle mail bez hlavičky `From`. Výsledok CELEJ
// fallback reťaze prejde `applyDefaultSenderName` (issue 433). `replyTo`
// (issue 358) sa ZÁMERNE neobaľuje — explicitný Reply-To sa prenáša doslovne,
// nenastavený spadne na už-obalený `from` (adresa vo vnútri `<>` sa nemení,
// odpovede stále idú na pôvodnú adresu).
export function resolveMailSender(
  config: Pick<SmtpMailConfig, "host" | "user" | "from" | "replyTo">,
): { readonly from: string; readonly replyTo: string } {
  const from = applyDefaultSenderName(config.from ?? config.user ?? config.host);
  const replyTo = config.replyTo ?? from;
  return { from, replyTo };
}

export function createSmtpMailTransport(config: SmtpMailConfig): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // Port 465 = implicitné TLS od začiatku spojenia (SMTPS), inak STARTTLS
    // (nodemailer si STARTTLS rieši sám, keď `secure: false`) — rovnaká
    // vetva ako stará appka's `_smtp_deliver` (`port == 465` → `SMTP_SSL`).
    secure: config.port === 465,
    auth:
      config.user !== undefined && config.user !== ""
        ? { user: config.user, pass: config.pass ?? "" }
        : undefined,
  });
  const { from, replyTo } = resolveMailSender(config);

  return async (message: MailMessage): Promise<void> => {
    await transporter.sendMail({
      from,
      replyTo,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    });
  };
}
