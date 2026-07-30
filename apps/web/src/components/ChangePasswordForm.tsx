import { useState, type SyntheticEvent, type JSX } from "react";
import { PasswordChangeUnauthorizedError, postChangePassword } from "../passwordApi.js";

// Musí zodpovedať `MIN_NEW_PASSWORD_LENGTH` v `apps/api/src/modules/auth/passwords.ts`
// (server je autoritatívny zdroj — toto len šetrí zbytočnú okružnú cestu na
// server pri zjavne krátkom hesle).
const MIN_NEW_PASSWORD_LENGTH = 8;

export function ChangePasswordForm({
  onSessionExpired,
}: {
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
      <h2>Zmena hesla</h2>
      <form onSubmit={(e) => { void submit(e); }}>
        <label htmlFor="old-password">Staré heslo</label>
        <input
          id="old-password"
          type="password"
          autoComplete="current-password"
          value={oldPassword}
          onChange={(e) => { setOldPassword(e.target.value); }}
          required
        />
        <label htmlFor="new-password">Nové heslo</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => { setNewPassword(e.target.value); }}
          required
        />
        <label htmlFor="new-password-confirm">Nové heslo znova</label>
        <input
          id="new-password-confirm"
          type="password"
          autoComplete="new-password"
          value={newPasswordConfirm}
          onChange={(e) => { setNewPasswordConfirm(e.target.value); }}
          required
        />
        <button type="submit" disabled={submitting}>Zmeniť heslo</button>
        {error !== "" && <p role="alert">{error}</p>}
        {success && <p data-testid="password-change-success">Heslo bolo úspešne zmenené</p>}
      </form>
    </section>
  );
}
