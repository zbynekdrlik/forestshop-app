import { useState, type SyntheticEvent, type JSX } from "react";
import { postLogin } from "../api.js";

export function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    setError("");
    try {
      if (await postLogin(email, password)) {
        onLoggedIn();
      } else {
        setError("Nesprávny e-mail alebo heslo");
      }
    } catch {
      setError("Prihlásenie zlyhalo — server neodpovedal");
    }
  }

  return (
    <form onSubmit={(e) => { void submit(e); }}>
      <h1>Prihlásenie</h1>
      <label htmlFor="email">E-mail</label>
      <input id="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} required />
      <label htmlFor="password">Heslo</label>
      <input id="password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} required />
      <button type="submit">Prihlásiť sa</button>
      {error !== "" && <p role="alert">{error}</p>}
    </form>
  );
}
