import { useCallback, useEffect, useState, type JSX } from "react";
import { fetchMe, postLogout, type Me } from "./api.js";
import { ChangePasswordForm } from "./components/ChangePasswordForm.js";
import { Footer } from "./components/Footer.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar } from "./components/Sidebar.js";
import { Topbar } from "./components/Topbar.js";
import { DEFAULT_TAB_ID, NAV, findTab, isVisibleTabId } from "./nav.js";

// Prvá záložka z URL-u (`?tab=<id>`), keď existuje a je platná — inak
// predvolená ("Sync zo Shoptetu"). Umožňuje priamy odkaz aj na SKRYTÉ
// obrazovky (katalóg/párovanie/plánovač — pozri `nav.ts`'s `HIDDEN_TABS`),
// bez toho, aby sa objavili v ľavom menu; presne toto využívajú
// `catalog.spec.ts`/`pairing.spec.ts`.
function initialTabId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("tab");
  if (fromUrl !== null && findTab(fromUrl) !== undefined) return fromUrl;
  return DEFAULT_TAB_ID;
}

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [meUnreachable, setMeUnreachable] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [activeTabId, setActiveTabId] = useState<string>(initialTabId);
  const [passwordPanelOpen, setPasswordPanelOpen] = useState(false);

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

  if (!loaded) return <main className="auth-page">Načítavam…</main>;

  if (meUnreachable) {
    return (
      <main className="auth-page">
        <div className="auth-shell">
          <p role="alert">Aplikácia nie je dostupná — server neodpovedá.</p>
        </div>
        <LoginForm onLoggedIn={reload} />
        <Footer />
      </main>
    );
  }

  if (me === null) {
    return (
      <main className="auth-page">
        <LoginForm onLoggedIn={reload} />
        <Footer />
      </main>
    );
  }

  // Aktívna záložka + jej titulok pre Topbar — `findTab` pozná AJ skryté
  // obrazovky (nav.ts's HIDDEN_TABS), takže priamy `?tab=` odkaz naň funguje
  // aj keď v `NAV` (ľavé menu) nie je.
  const tab = findTab(activeTabId) ?? findTab(DEFAULT_TAB_ID);
  const ActiveComponent = tab?.Component ?? null;

  function selectTab(id: string): void {
    setActiveTabId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="app-shell">
      <Sidebar folders={NAV} activeTabId={activeTabId} onSelectTab={selectTab} />
      <div className="main">
        <Topbar
          title={isVisibleTabId(activeTabId) ? (tab?.label ?? null) : null}
          greeting={`Prihlásený: ${me.displayName} (${me.role})`}
          onLogout={logout}
          passwordPanelOpen={passwordPanelOpen}
          onTogglePasswordPanel={() => {
            setPasswordPanelOpen((open) => !open);
          }}
        >
          <ChangePasswordForm email={me.email} onSessionExpired={reload} />
        </Topbar>
        <main>
          {logoutError !== "" && <p role="alert">{logoutError}</p>}
          {ActiveComponent !== null && <ActiveComponent role={me.role} onSessionExpired={reload} />}
        </main>
      </div>
    </div>
  );
}
