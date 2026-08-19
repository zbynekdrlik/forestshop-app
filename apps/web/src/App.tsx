import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { fetchMe, postLogout, type Me } from "./api.js";
import { applyThemeColors } from "./applyThemeColors.js";
import { buildAutomationStatus, STATIC_AUTOMATION_STATUS } from "./automationStatus.js";
import { ChangePasswordForm } from "./components/ChangePasswordForm.js";
import { Footer } from "./components/Footer.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar } from "./components/Sidebar.js";
import { Topbar } from "./components/Topbar.js";
import { fetchDpdShippableCount } from "./dpdApi.js";
import { DpdBadgeRefreshContext } from "./dpdBadgeContext.js";
import { DEFAULT_TAB_ID, NAV, findTab, isVisibleTabId } from "./nav.js";
import { fetchOrderFlagCounts } from "./orderFlagsApi.js";
import { OrderFlagsBadgeRefreshContext } from "./orderFlagsBadgeContext.js";
import { fetchOrderReminderStatus } from "./orderReminderApi.js";
import { OrdersRemainingCountContext } from "./ordersRemainingCountContext.js";
import { fetchPairingReviewUnreviewedCount } from "./pairingReviewApi.js";
import { PairingReviewBadgeRefreshContext } from "./pairingReviewBadgeContext.js";
import { fetchPostaUncollectedStatus } from "./postaUncollectedApi.js";
import { fetchRestockStatus } from "./restockApi.js";
import { fetchThemeColors } from "./themeColorsApi.js";
import { fetchUpozorneniaCount } from "./upozorneniaApi.js";
import { UpozorneniaBadgeRefreshContext } from "./upozorneniaBadgeContext.js";

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
  // issue 267 (živé overenie, gap 1): mutácia spravená na PRÁVE otvorenej
  // "Upozornenia" obrazovke (vytvorenie/odloženie/vybavenie/...) nemení
  // `activeTabId`, takže bez tohto by odznak refetchol len pri zmene
  // záložky. `UpozorneniaSection` zavolá `refresh()` (cez
  // `UpozorneniaBadgeRefreshContext`) po každej úspešnej mutácii, čo
  // bumpne tento nonce a zaradí sa do dependency poľa nižšie — count
  // pritom naďalej vlastní/fetchuje TENTO efekt, nie obrazovka.
  const [upozorneniaRefreshNonce, setUpozorneniaRefreshNonce] = useState(0);
  const upozorneniaBadgeRefresh = useCallback(() => {
    setUpozorneniaRefreshNonce((n) => n + 1);
  }, []);
  const upozorneniaBadgeContextValue = useMemo(() => ({ refresh: upozorneniaBadgeRefresh }), [upozorneniaBadgeRefresh]);
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
  }, [me, activeTabId, upozorneniaRefreshNonce]);

  // issue 445: odznak "Objednať DPD" — presná kópia `upozorneniaCount`
  // vzoru vyššie (App.tsx vlastní count, fetchuje ho pri prihlásení/zmene
  // záložky/refresh-nonce, žiaden polling). Šéf chce hneď vidieť, koľko
  // objednávok dnes treba objednať cez DPD. `DpdSection` po úspešnom
  // odoslaní zásielok zavolá `refresh()` (cez `DpdBadgeRefreshContext`), čo
  // bumpne tento nonce a číslo v menu HNEĎ klesne.
  const [dpdCount, setDpdCount] = useState<number | null>(null);
  const [dpdRefreshNonce, setDpdRefreshNonce] = useState(0);
  const dpdBadgeRefresh = useCallback(() => {
    setDpdRefreshNonce((n) => n + 1);
  }, []);
  const dpdBadgeContextValue = useMemo(() => ({ refresh: dpdBadgeRefresh }), [dpdBadgeRefresh]);
  useEffect(() => {
    if (me === null) return;
    let cancelled = false;
    fetchDpdShippableCount()
      .then((count) => {
        if (!cancelled) setDpdCount(count);
      })
      .catch(() => {
        // `fetchDpdShippableCount` už interne zachytáva všetky chyby a vždy
        // vráti 0 (`dpdApi.ts`) — tento catch je len poistka pre eslint
        // `no-floating-promises`, nikdy by sa reálne nemal spustiť.
      });
    return () => {
      cancelled = true;
    };
  }, [me, activeTabId, dpdRefreshNonce]);

  // issue 387 E5/E6: odznak "Párovanie" — rovnaký PRIAMY vzor ako
  // `upozorneniaCount` vyššie (musí byť známy hneď po prihlásení, nikdy len
  // po prvom otvorení záložky — issue 331's pôvodné poučenie o
  // VIDITEĽNOSTI, uplatnené TU; #311's vlastný odznak bol issue 387 E8
  // odstránený spolu s celou obrazovkou, ktorú toto párovanie nahrádza).
  // "unreviewed" (design komentár na tickete) = koľko produktov z gather
  // populácie ešte NEMÁ efektívnu dodávateľskú linku A nemá TERMINÁLNE
  // rozhodnutie. issue 387 E6 pridalo mutácie (rozhodnutia) —
  // `PairingReviewCard`/`Section` zavolá `refresh()` (cez
  // `PairingReviewBadgeRefreshContext`) po každom úspešnom zápise.
  const [pairingReviewUnreviewedCount, setPairingReviewUnreviewedCount] = useState<number | null>(null);
  const [pairingReviewRefreshNonce, setPairingReviewRefreshNonce] = useState(0);
  const pairingReviewBadgeRefresh = useCallback(() => {
    setPairingReviewRefreshNonce((n) => n + 1);
  }, []);
  const pairingReviewBadgeContextValue = useMemo(() => ({ refresh: pairingReviewBadgeRefresh }), [pairingReviewBadgeRefresh]);
  useEffect(() => {
    if (me === null) return;
    let cancelled = false;
    fetchPairingReviewUnreviewedCount()
      .then((count) => {
        if (!cancelled) setPairingReviewUnreviewedCount(count);
      })
      .catch(() => {
        // Sieťový výpadok — odznak zostane na poslednej známej hodnote.
      });
    return () => {
      cancelled = true;
    };
  }, [me, activeTabId, pairingReviewRefreshNonce]);

  // issue 290: odznaky "Výmena tovaru"/"Vrátený tovar"/"Reklamácie" — rovnaký
  // priamy vzor ako `upozorneniaCount` vyššie (JEDEN endpoint, `App.tsx` si
  // ho volá sám, počty musia byť známe hneď po prihlásení). Na rozdiel od
  // Upozornení má JEDEN spoločný refresh-spúšťač namiesto troch, lebo
  // mutuje ich len JEDNA z troch obrazoviek (`ClaimOrdersSection`), ale
  // odznak potrebujú refetchovať všetky tri naraz (mark/clear môže zmeniť
  // len `claims`, no netreba to rozlišovať — samostatný refetch pre jedno
  // číslo by bol zbytočná zložitosť navyše pre appku tejto veľkosti).
  const [orderFlagCounts, setOrderFlagCounts] = useState<{ readonly exchange: number; readonly returned: number; readonly claims: number } | null>(
    null,
  );
  const [orderFlagsRefreshNonce, setOrderFlagsRefreshNonce] = useState(0);
  const orderFlagsBadgeRefresh = useCallback(() => {
    setOrderFlagsRefreshNonce((n) => n + 1);
  }, []);
  const orderFlagsBadgeContextValue = useMemo(() => ({ refresh: orderFlagsBadgeRefresh }), [orderFlagsBadgeRefresh]);
  useEffect(() => {
    if (me === null) return;
    let cancelled = false;
    fetchOrderFlagCounts()
      .then((counts) => {
        if (!cancelled) setOrderFlagCounts(counts);
      })
      .catch(() => {
        // `fetchOrderFlagCounts` už interne zachytáva všetky chyby a vždy
        // vráti nuly (`orderFlagsApi.ts`) — tento catch je len poistka pre
        // eslint `no-floating-promises`, nikdy by sa reálne nemal spustiť.
      });
    return () => {
      cancelled = true;
    };
  }, [me, activeTabId, orderFlagsRefreshNonce]);

  const badgeCounts = useMemo<Readonly<Record<string, number>>>(() => {
    const counts: Record<string, number> = {};
    if (ordersRemainingCount !== null) counts["orders"] = ordersRemainingCount;
    if (upozorneniaCount !== null) counts["upozornenia"] = upozorneniaCount;
    // issue 445: odznak sa ukazuje AJ pri nule (rovnako ako "upozornenia"/
    // "pairing-review" — appka tým hovorí "toto číslo poznám, je 0"), aby
    // šéf hneď videl "dnes netreba objednať žiadnu DPD prepravu".
    if (dpdCount !== null) counts["dpd"] = dpdCount;
    // issue 387 E5 (pôvodne issue 331's princíp, teraz uplatnené tu): odznak
    // sa ukazuje AJ pri nule (appka tým hovorí "toto číslo poznám, je 0" —
    // presne to majiteľovi chýbalo, keď číslo poznal len z ručného SQL
    // dopytu).
    if (pairingReviewUnreviewedCount !== null) counts["pairing-review"] = pairingReviewUnreviewedCount;
    // issue 290: na rozdiel od "orders"/"upozornenia" vyššie (odznak sa
    // ukazuje AJ pri nule — appka tým hovorí "toto číslo poznám, je 0")
    // tieto tri odznaky sa VÔBEC nezobrazujú pri nule (ticket: "shown only
    // when >0") — chýbajúci kľúč v `badgeCounts`, nie "0" hodnota.
    if (orderFlagCounts !== null) {
      if (orderFlagCounts.exchange > 0) counts["exchange"] = orderFlagCounts.exchange;
      if (orderFlagCounts.returned > 0) counts["returned"] = orderFlagCounts.returned;
      if (orderFlagCounts.claims > 0) counts["claims"] = orderFlagCounts.claims;
    }
    return counts;
    // Code review (pred mergom, issue 290): `orderFlagCounts` sa v tele číta,
    // ale chýbal v dependency poli — appka tu NEMÁ `eslint-plugin-react-hooks`
    // (`.claude/rules/frontend-design.md`'s zdokumentovaná past, presne ten
    // istý tvar bugu ako `UpozorneniaSection.tsx`'s `withBusy`), takže lint
    // to nezachytí a stará hodnota (chýbajúce odznaky hneď po prihlásení,
    // kým sa nespustí NEJAKÝ INÝ trigger) prežije bez varovania.
  }, [ordersRemainingCount, upozorneniaCount, dpdCount, pairingReviewUnreviewedCount, orderFlagCounts]);

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
    // issue 447 — pilulka „Beží"/„Zastavené" pri VŠETKÝCH automatizáciách:
    // togglované (posta/order-reminder/restock) podľa `enabled`, always-on
    // joby (supplier-stock/sync) staticky „on" cez `buildAutomationStatus`.
    Promise.all([fetchPostaUncollectedStatus(), fetchOrderReminderStatus(), fetchRestockStatus()])
      .then(([posta, reminder, restock]) => {
        if (cancelled) return;
        setAutomationStatus(
          buildAutomationStatus({ postaUncollected: posta.enabled, orderReminder: reminder.enabled, restock: restock.enabled }),
        );
      })
      .catch(() => {
        // Sieťový výpadok — togglované automatizácie necháme bez pilulky
        // (nezavádzať falošné „Zastavené"), ale always-on statické (supplier-
        // stock/sync) ukáž aj tak. Odznak v menu nie je kritický.
        if (!cancelled) setAutomationStatus(STATIC_AUTOMATION_STATUS);
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
      <UpozorneniaBadgeRefreshContext.Provider value={upozorneniaBadgeContextValue}>
        <DpdBadgeRefreshContext.Provider value={dpdBadgeContextValue}>
          <PairingReviewBadgeRefreshContext.Provider value={pairingReviewBadgeContextValue}>
            <OrderFlagsBadgeRefreshContext.Provider value={orderFlagsBadgeContextValue}>
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
            </OrderFlagsBadgeRefreshContext.Provider>
          </PairingReviewBadgeRefreshContext.Provider>
        </DpdBadgeRefreshContext.Provider>
      </UpozorneniaBadgeRefreshContext.Provider>
    </OrdersRemainingCountContext.Provider>
  );
}
