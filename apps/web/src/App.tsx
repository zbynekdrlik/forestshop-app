import { useCallback, useEffect, useState, type JSX } from "react";
import { fetchMe, postLogout, type Me } from "./api.js";
import { Footer } from "./components/Footer.js";
import { LoginForm } from "./components/LoginForm.js";

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void fetchMe().then((u) => { setMe(u); setLoaded(true); });
  }, []);

  useEffect(reload, [reload]);

  if (!loaded) return <main>Načítavam…</main>;
  if (me === null) return <main><LoginForm onLoggedIn={reload} /><Footer /></main>;

  return (
    <main>
      <h1>Forestshop</h1>
      <p data-testid="greeting">Prihlásený: {me.displayName} ({me.role})</p>
      <button type="button" onClick={() => { void postLogout().then(reload); }}>Odhlásiť sa</button>
      <Footer />
    </main>
  );
}
