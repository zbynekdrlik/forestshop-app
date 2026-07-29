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
    <form onSubmit={(e) => { void submit(e); }}>
      <h1>Prihlásenie</h1>
      <label htmlFor="email">E-mail</label>
      <input id="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} required />
      <label htmlFor="password">Heslo</label>
      <input id="password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} required />
      <button type="submit" disabled={submitting}>Prihlásiť sa</button>
      {error !== "" && <p role="alert">{error}</p>}
    </form>
  );
}
