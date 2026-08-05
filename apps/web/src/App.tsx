import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { fetchMe, postLogout, type Me } from "./api.js";
import { applyThemeColors } from "./applyThemeColors.js";
import { ChangePasswordForm } from "./components/ChangePasswordForm.js";
import { Footer } from "./components/Footer.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar } from "./components/Sidebar.js";
import { Topbar } from "./components/Topbar.js";
import { DEFAULT_TAB_ID, NAV, findTab, isVisibleTabId } from "./nav.js";
import { fetchOrderReminderStatus } from "./orderReminderApi.js";
import { OrdersRemainingCountContext } from "./ordersRemainingCountContext.js";
import { fetchPostaUncollectedStatus } from "./postaUncollectedApi.js";
import { fetchThemeColors } from "./themeColorsApi.js";
import { fetchUpozorneniaCount } from "./upozorneniaApi.js";

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
  // issue 147: odznak počtu nevybavených riadkov "Na objednanie" v ľavom menu
  // — `OrdersSection` (kdekoľvek je práve zmountnutá) ho publikuje cez
  // `OrdersRemainingCountContext`, App.tsx (spoločný predok Sidebar-u aj
  // aktívnej záložky) drží poslednú známú hodnotu a posiela ju do `Sidebar`
  // generickým `badgeCounts` prop-om — žiadne "if tab === orders" tu.
  const [ordersRemainingCount, setOrdersRemainingCount] = useState<number | null>(null);
  const ordersRemainingCountContextValue = useMemo(
    () => ({ count: ordersRemainingCount, setCount: setOrdersRemainingCount }),
    [ordersRemainingCount],
  );
  // issue 267: odznak "Upozornenia" — na rozdiel od `ordersRemainingCount`
  // vyššie (publikované OBRAZOVKOU cez context, teda známe až po jej prvom
  // zmountovaní) musí byť toto číslo známe HNEĎ po prihlásení, ešte pred
  // prvým otvorením záložky — preto ide rovnakým priamym vzorom ako
  // `automationStatus` nižšie (App.tsx si volá `fetch*` sám), nie cez
  // context.
  const [upozorneniaCount, setUpozorneniaCount] = useState<number | null>(null);
  useEffect(() => {
    if (me === null) return;
    let cancelled = false;
    fetchUpozorneniaCount()
      .then((count) => {
        if (!cancelled) setUpozorneniaCount(count);
      })
      .catch(() => {
        // Sieťový výpadok — odznak zostane na poslednej známej hodnote.
      });
    return () => {
      cancelled = true;
    };
  }, [me, activeTabId]);

  const badgeCounts = useMemo<Readonly<Record<string, number>>>(() => {
    const counts: Record<string, number> = {};
    if (ordersRemainingCount !== null) counts["orders"] = ordersRemainingCount;
    if (upozorneniaCount !== null) counts["upozornenia"] = upozorneniaCount;
    return counts;
  }, [ordersRemainingCount, upozorneniaCount]);

  // issue 185: stav zapnuté/vypnuté pre "Automatizácie" priečinok v menu.
  // Na rozdiel od `ordersRemainingCount` vyššie (publikované OBRAZOVKOU
  // samotnou cez context) tu App.tsx volá PRIAMO tie isté existujúce
  // `fetch*Status` funkcie, čo už používajú `PostaUncollectedSection`/
  // `OrderReminderSection` — jednoduchšie než pridávať ďalší zdieľaný context
  // len pre dve políčka, ktoré sa menia zriedka (Štart/Stop klik). Refetch pri
  // KAŽDEJ zmene aktívnej záložky zachytí prípadný toggle spravený na tej
  // obrazovke hneď po návrate na inú záložku. `nedostupne` do tejto mapy
  // úmyselne nepatrí — nemá `enabled` koncept vôbec (Sidebar chýbajúci kľúč =
  // žiadny odznak).
  const [automationStatus, setAutomationStatus] = useState<Readonly<Record<string, "on" | "off">>>({});
  useEffect(() => {
    if (me === null) return;
    let cancelled = false;
    Promise.all([fetchPostaUncollectedStatus(), fetchOrderReminderStatus()])
      .then(([posta, reminder]) => {
        if (cancelled) return;
        setAutomationStatus({
          "posta-uncollected": posta.enabled ? "on" : "off",
          "order-reminder": reminder.enabled ? "on" : "off",
        });
      })
      .catch(() => {
        // Sieťový výpadok — odznak v menu nie je kritický, ticho ponechá
        // predošlý (alebo žiadny) stav namiesto nespracovanej výnimky.
      });
    return () => {
      cancelled = true;
    };
  }, [me, activeTabId]);

  // issue 264: farby bublinek dodávateľov sa premietnu ako CSS premenné na
  // `document.documentElement` HNEĎ po prihlásení — pre KAŽDÉHO používateľa
  // (nielen toho, kto má popup "Farby aplikácie" otvorený), keďže čipy vidia
  // všetci. Beží raz pri prihlásení, nie pri každom prepnutí záložky —
  // farby sa počas relácie menia len cez ten istý popup, ktorý si aplikuje
  // živý náhľad sám.
  useEffect(() => {
    if (me === null) return;
    fetchThemeColors()
      .then((colors) => {
        applyThemeColors(Object.fromEntries(colors.map((c) => [c.key, c.value])));
      })
      .catch(() => {
        // Sieťový výpadok — appka zostane pri predvolených farbách z
        // `app.css`, nič kritické.
      });
  }, [me]);

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
    <OrdersRemainingCountContext.Provider value={ordersRemainingCountContextValue}>
      <div className="app-shell">
        <Sidebar
          folders={NAV}
          activeTabId={activeTabId}
          onSelectTab={selectTab}
          badgeCounts={badgeCounts}
          badgeStatus={automationStatus}
        />
        <div className="main">
          <Topbar
            title={isVisibleTabId(activeTabId) ? (tab?.label ?? null) : null}
            greeting={`Prihlásený: ${me.displayName} (${me.role})`}
            role={me.role}
            onSessionExpired={reload}
            onLogout={logout}
            passwordPanelOpen={passwordPanelOpen}
            onTogglePasswordPanel={() => {
              setPasswordPanelOpen((open) => !open);
            }}
          >
            <ChangePasswordForm email={me.email} onSessionExpired={reload} />
          </Topbar>
          <main className={tab?.wide === true ? "main-wide" : undefined}>
            {logoutError !== "" && <p role="alert">{logoutError}</p>}
            {ActiveComponent !== null && <ActiveComponent role={me.role} onSessionExpired={reload} />}
          </main>
        </div>
      </div>
    </OrdersRemainingCountContext.Provider>
  );
}
