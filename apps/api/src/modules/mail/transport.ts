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
}

// Odosielateľ: explicitný `MAIL_FROM`, inak SMTP účet (`user`), inak
// samotný host — appka nikdy nepošle mail bez hlavičky `From`.
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
  const from = config.from ?? config.user ?? config.host;

  return async (message: MailMessage): Promise<void> => {
    await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    });
  };
}
