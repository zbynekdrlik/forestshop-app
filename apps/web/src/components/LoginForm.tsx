import { useState, type SyntheticEvent, type JSX } from "react";
import { postLogin } from "../api.js";

export function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return; // dvojklik/opakovaný Enter počas prebiehajúcej požiadavky
    setSubmitting(true);
    setError("");
    try {
      if (await postLogin(email, password)) {
        onLoggedIn();
      } else {
        setPassword("");
        setError("Nesprávny e-mail alebo heslo");
      }
    } catch {
      setPassword("");
      setError("Prihlásenie zlyhalo — server neodpovedal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(e) => { void submit(e); }}>
        <h1>Prihlásenie</h1>
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} required />
        </div>
        <div className="field">
          <label htmlFor="password">Heslo</label>
          <input id="password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} required />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn good" disabled={submitting}>Prihlásiť sa</button>
        </div>
        {error !== "" && <p role="alert">{error}</p>}
      </form>
    </div>
  );
}
