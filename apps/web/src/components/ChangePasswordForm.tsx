import { useState, type SyntheticEvent, type JSX } from "react";
import { PasswordChangeUnauthorizedError, postChangePassword } from "../passwordApi.js";

// Musí zodpovedať `MIN_NEW_PASSWORD_LENGTH` v `apps/api/src/modules/auth/passwords.ts`
// (server je autoritatívny zdroj — toto len šetrí zbytočnú okružnú cestu na
// server pri zjavne krátkom hesle).
const MIN_NEW_PASSWORD_LENGTH = 8;

export function ChangePasswordForm({
  email,
  onSessionExpired,
}: {
  // E-mail PRIHLÁSENÉHO používateľa (issue 47, komentár k zbaleniu) — nesie
  // ho len skryté `autoComplete="username"` pole nižšie, aby Chrome prestal
  // pri KAŽDOM načítaní logovať accessibility hint "Password forms should
  // have (optionally hidden) username fields" (formulár mal predtým 3
  // heslové polia a ŽIADNE meno používateľa — PR 56 doplnila len
  // `autoComplete="current-password"`/`"new-password"` na samotné polia,
  // toto rieši ZVYŠNÝ hint). Appka žiadny <form> na zmenu e-mailu nemá, takže
  // toto pole nikdy nič neodošle na server ani ho nemení — čisto pre
  // prehliadačov password manager.
  readonly email: string;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return; // dvojklik/opakovaný Enter počas prebiehajúcej požiadavky
    setSuccess(false);
    setError("");

    if (newPassword !== newPasswordConfirm) {
      setError("Nové heslo a jeho potvrdenie sa nezhodujú");
      return;
    }
    if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
      setError(`Nové heslo musí mať aspoň ${String(MIN_NEW_PASSWORD_LENGTH)} znakov`);
      return;
    }

    setSubmitting(true);
    try {
      const result = await postChangePassword(oldPassword, newPassword);
      if (result.ok) {
        setSuccess(true);
        setOldPassword("");
        setNewPassword("");
        setNewPasswordConfirm("");
      } else {
        setError(result.error);
      }
    } catch (err) {
      if (err instanceof PasswordChangeUnauthorizedError) {
        onSessionExpired();
        return;
      }
      setError("Zmena hesla zlyhala — server neodpovedal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h3>Zmena hesla</h3>
      <form onSubmit={(e) => { void submit(e); }}>
        {/* Skryté, nikdy needituje/needosiela nič — len autoComplete="username"
            pre prehliadačov password manager (viď komentár pri props vyššie). */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <div className="field">
          <label htmlFor="old-password">Staré heslo</label>
          <input
            id="old-password"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => { setOldPassword(e.target.value); }}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-password">Nové heslo</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); }}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-password-confirm">Nové heslo znova</label>
          <input
            id="new-password-confirm"
            type="password"
            autoComplete="new-password"
            value={newPasswordConfirm}
            onChange={(e) => { setNewPasswordConfirm(e.target.value); }}
            required
          />
        </div>
        <button type="submit" className="btn sm good" disabled={submitting}>Zmeniť heslo</button>
        {error !== "" && <p role="alert">{error}</p>}
        {success && <p role="status" data-testid="password-change-success">Heslo bolo úspešne zmenené</p>}
      </form>
    </section>
  );
}
