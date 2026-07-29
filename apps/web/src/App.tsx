import { useCallback, useEffect, useState, type JSX } from "react";
import { fetchMe, postLogout, type Me } from "./api.js";
import { CatalogPage } from "./components/CatalogPage.js";
import { Footer } from "./components/Footer.js";
import { LoginForm } from "./components/LoginForm.js";

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [meUnreachable, setMeUnreachable] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const reload = useCallback(() => {
    setMeUnreachable(false);
    fetchMe()
      .then((u) => {
        setMe(u);
        setLoaded(true);
      })
      .catch(() => {
        // Network failure, malformed response, or a non-2xx/401 status —
        // stop the loading state and let the user know the app is
        // unreachable instead of spinning on "Načítavam…" forever.
        setMe(null);
        setMeUnreachable(true);
        setLoaded(true);
      });
  }, []);

  useEffect(reload, [reload]);

  const logout = useCallback(() => {
    setLogoutError("");
    postLogout()
      .then(reload)
      .catch(() => {
        // A failed logout request must not leave the UI in a wrong state —
        // keep showing the dashboard (the user is still logged in as far as
        // the server knows) and surface the failure instead.
        setLogoutError("Odhlásenie zlyhalo — server neodpovedal");
      });
  }, [reload]);

  if (!loaded) return <main>Načítavam…</main>;

  if (meUnreachable) {
    return (
      <main>
        <p role="alert">Aplikácia nie je dostupná — server neodpovedá.</p>
        <LoginForm onLoggedIn={reload} />
        <Footer />
      </main>
    );
  }

  if (me === null) {
    return (
      <main>
        <LoginForm onLoggedIn={reload} />
        <Footer />
      </main>
    );
  }

  return (
    <main>
      <h1>Forestshop</h1>
      <p data-testid="greeting">
        Prihlásený: {me.displayName} ({me.role})
      </p>
      <button type="button" onClick={logout}>
        Odhlásiť sa
      </button>
      {logoutError !== "" && <p role="alert">{logoutError}</p>}
      <CatalogPage />
      <Footer />
    </main>
  );
}
