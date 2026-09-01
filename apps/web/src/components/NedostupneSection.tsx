import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  addReplacementLink,
  fetchNedostupneList,
  fetchNedostupnePreview,
  NedostupneUnauthorizedError,
  removeReplacementLink,
  sendNedostupneEmail,
  type NedostupneEmailType,
  type NedostupneGroup,
  type NedostupneList,
  type NedostupnePreview,
} from "../nedostupneApi.js";
import { useNedostupneResolved } from "../useNedostupneResolved.js";
import { formatNedostupneTotalChip } from "../nedostupneSummary.js";
// issue 529: poznámka do eshopu — ZDIEĽANÁ zapisovacia cesta so stĺpcom POZNÁMKY
// v „Na objednanie" (`updateOrderComment` → `PUT /api/orders/:id/comment` →
// `order.comment` → Shoptet writeback worker), žiadny nový mechanizmus.
import { updateOrderComment, OrdersUnauthorizedError } from "../ordersApi.js";
import { MailPreviewDialog } from "./MailPreviewDialog.js";
import { NedostupneOrderNote } from "./NedostupneOrderNote.js";

// Rovnaké dve role, ktoré server vyžaduje na odoslanie (`requireRole("admin",
// "manazer")`, `nedostupne-routes.ts`) — čítanie (zoznam) smie vidieť KAŽDÝ
// prihlásený zamestnanec, rovnaká úroveň ako #172/#173.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

interface PendingSend {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly emailType: NedostupneEmailType;
  readonly preview: NedostupnePreview;
}

function itemLabel(group: NedostupneGroup): string {
  return group.sizeLabel === null ? group.itemName : `${group.itemName} — veľkosť ${group.sizeLabel}`;
}

export function NedostupneSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [list, setList] = useState<NedostupneList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<PendingSend | null>(null);
  // issue 277: obsluhou upravený text okna náhľadu — predvyplnený z
  // `preview.text` pri otvorení, needovateľný pri zatvorení/novom otvorení.
  const [editedBody, setEditedBody] = useState("");
  // issue 191: spúšťacie tlačidlo si pamätáme už pri kliknutí — kým sa náhľad
  // načítava, je `disabled` a prehliadač z neho fokus zhodí, takže po zavretí
  // dialógu by sa nemal kam vrátiť (naživo overené na produkcii).
  const triggerRef = useRef<HTMLElement | null>(null);
  const canControl = CONTROL_ROLES.has(role);
  // issue 238: majiteľove RUČNE vložené odkazy náhrad — draft rozpísaného
  // odkazu je per-GROUP (variantCode), nie globálny; `busyKey` vyššie je
  // vyhradený pre náhľad/odoslanie, preto má tento blok VLASTNÝ busy stav
  // (rôzne akcie na tej istej karte sa nesmú vzájomne blokovať).
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});
  const [linkBusy, setLinkBusy] = useState("");
  // issue 529: rozpísaná poznámka objednávky — per-riadok (kľúč
  // `${variantCode}|${orderCode}`), rovnaký draft-map vzor ako `linkDrafts`
  // vyššie (nie zložitejší `OrderLineRow` dirty-guard, ktorý rieši VIAC riadkov
  // tej istej objednávky súčasne — tu je každý riadok samostatný input, po
  // uložení sa zoznam znovu načíta zo servera). `undefined` v mape = zobraz
  // priamo aktuálnu `order.comment`.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteBusy, setNoteBusy] = useState("");
  // issue 531: ručné označenie „vyriešené" — stav + optimistický toggle žije vo
  // vlastnom hooku (eslint `max-lines`), rovnaká „lift do hooku" disciplína ako
  // `useLoadMore`/`useStaleResponseGuard`.
  const { resolvedBusy, toggleResolved } = useNedostupneResolved({ setList, setActionError, onSessionExpired });

  const load = useCallback(() => {
    fetchNedostupneList()
      .then((l) => {
        setList(l);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof NedostupneUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Nedostupné tovary sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const openPreview = useCallback(
    (orderCode: string, variantCode: string, emailType: NedostupneEmailType) => {
      const key = `${orderCode}|${variantCode}|${emailType}`;
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setActionError("");
      setBusyKey(key);
      fetchNedostupnePreview(orderCode, variantCode, emailType)
        .then((preview) => {
          setPending({ orderCode, variantCode, emailType, preview });
          setEditedBody(preview.text);
        })
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Náhľad sa nepodarilo načítať.");
        })
        .finally(() => {
          setBusyKey("");
        });
    },
    [onSessionExpired],
  );

  const confirmSend = useCallback(() => {
    if (pending === null) return;
    const key = `${pending.orderCode}|${pending.variantCode}|${pending.emailType}`;
    setBusyKey(key);
    sendNedostupneEmail(pending.orderCode, pending.variantCode, pending.emailType, pending.preview.previewToken, editedBody)
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setPending(null);
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof NedostupneUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setActionError(err instanceof Error ? err.message : "Odoslanie zlyhalo.");
      })
      .finally(() => {
        setBusyKey("");
      });
  }, [pending, editedBody, load, onSessionExpired]);

  // issue 238: pridanie majiteľovho ručného odkazu náhrady — po úspechu sa
  // draft vyprázdni a zoznam sa znova načíta (server je zdroj pravdy, žiadny
  // optimistický lokálny insert).
  const addLink = useCallback(
    (variantCode: string) => {
      const url = (linkDrafts[variantCode] ?? "").trim();
      if (url === "") return;
      setActionError("");
      setLinkBusy(variantCode);
      addReplacementLink(variantCode, url)
        .then(() => {
          setLinkDrafts((drafts) => ({ ...drafts, [variantCode]: "" }));
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Odkaz sa nepodarilo pridať.");
        })
        .finally(() => {
          setLinkBusy("");
        });
    },
    [linkDrafts, load, onSessionExpired],
  );

  const removeLink = useCallback(
    (id: string) => {
      setActionError("");
      setLinkBusy(id);
      removeReplacementLink(id)
        .then(load)
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Odkaz sa nepodarilo zmazať.");
        })
        .finally(() => {
          setLinkBusy("");
        });
    },
    [load, onSessionExpired],
  );

  // issue 529: uloženie poznámky objednávky do eshopu — TÁ ISTÁ zapisovacia
  // cesta ako stĺpec POZNÁMKY v „Na objednanie" (`updateOrderComment` →
  // `PUT /api/orders/:id/comment` → `order.comment` → Shoptet writeback worker),
  // žiadny nový mechanizmus. Po úspechu sa zoznam znovu načíta (server je zdroj
  // pravdy) a draft daného riadku sa zahodí, aby predvyplnenie sedelo s novou
  // uloženou hodnotou. Prázdny reťazec maže poznámku (server ho normalizuje na
  // `null`, rovnako ako `changeComment` v „Na objednanie").
  const saveNote = useCallback(
    (noteKey: string, orderCode: string, orderId: string, value: string) => {
      setActionError("");
      setNoteBusy(noteKey);
      const trimmed = value.trim();
      updateOrderComment(orderId, trimmed === "" ? null : trimmed)
        .then(() => {
          // Zahoď draft TEJTO objednávky VO VŠETKÝCH skupinách (poznámka patrí
          // OBJEDNÁVKE, kľúč je `${variantCode}|${orderCode}`) — tá istá
          // objednávka môže čakať na dva nedostupné varianty, takže po uložení
          // sa jej riadky v oboch skupinách predvyplnia z novej `order.comment`,
          // nikdy neostane zastaraný draft maskujúci čerstvú hodnotu (code
          // review nález, issue 529).
          setNoteDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([key]) => !key.endsWith(`|${orderCode}`))));
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Poznámku sa nepodarilo uložiť.");
        })
        .finally(() => {
          setNoteBusy("");
        });
    },
    [load, onSessionExpired],
  );

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (list === null) return <p role="alert">Nedostupné tovary sa nepodarilo načítať.</p>;

  return (
    <section>
      <p>Tovary, ktoré dodávateľ nemá, spárované s otvorenými objednávkami zákazníkov, ktorí na ne čakajú.</p>

      {list.bccMissing && (
        <p role="alert" data-testid="nedostupne-bcc-missing">
          ⚠️ Chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL) — automatizácia zatiaľ NEPOŠLE žiadny e-mail zákazníkovi.
        </p>
      )}
      {list.mailNotConfigured && (
        <p role="alert" data-testid="nedostupne-mail-not-configured">
          ⚠️ Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST).
        </p>
      )}
      {actionError !== "" && <p role="alert">{actionError}</p>}

      {list.groups.length === 0 ? (
        <p data-testid="nedostupne-empty">Žiadny tovar momentálne nie je označený ako nedostupný.</p>
      ) : (
        <div className="nedostupne-groups" data-testid="nedostupne-groups">
          {list.groups.map((group) => {
            // issue 443: celkový počet kusov produktu naprieč objednávkami
            // skupiny — rovnaký odznak `Σ N` (`.qty-total-chip`) ako na "Na
            // objednanie", viditeľný len keď je viac než jedna objednávka.
            const totalChip = formatNedostupneTotalChip(group.orders);
            return (
              <div className="card" key={group.variantCode} data-testid={`nedostupne-group-${group.variantCode}`}>
                <div className="nedostupne-group-header">
                  {/* issue 238: preklik na náš e-shop — `null` = adresu vo
                      feede nemáme, meno ostáva NEAKTÍVNY plain text (nikdy
                      vyhľadávací fallback, majiteľova výslovná podmienka). */}
                  <span className="nedostupne-group-name">
                    {group.ourProductUrl !== null ? (
                      <a href={group.ourProductUrl} target="_blank" rel="noreferrer" data-testid={`nedostupne-shop-link-${group.variantCode}`}>
                        {itemLabel(group)}
                      </a>
                    ) : (
                      itemLabel(group)
                    )}
                  </span>
                  {/* issue 238: preklik na dodávateľa — rovnaká funkcia ako
                      "Na objednanie" (`resolveEffectiveSupplierLink`). */}
                  {group.supplierUrl !== null ? (
                    <a className="pill off" href={group.supplierUrl} target="_blank" rel="noreferrer" data-testid={`nedostupne-supplier-link-${group.variantCode}`}>
                      {group.variantCode}
                    </a>
                  ) : (
                    <span className="pill off">{group.variantCode}</span>
                  )}
                  {/* issue 443: celkový počet kusov naprieč objednávkami skupiny. */}
                  {totalChip !== null && (
                    <span className="qty-total-chip" data-testid={`nedostupne-total-${group.variantCode}`} title={totalChip.title}>
                      {totalChip.text}
                    </span>
                  )}
                  {/* issue 529: preklik do „Na objednanie" presne na tento produkt.
                      📦 (emoji sekcie „Na objednanie") bez textu, štvorcové tlačidlo
                      rovnakého vzhľadu ako `@` (`.customer-contact-btn`). Celá
                      navigácia stránky (`?tab=orders&highlight=<kód>`), rovnaký vzor
                      ako `FloorOrderRow`'s `?tab=floor-orders` — NedostupneSection
                      nemá `selectTab`; `OrdersSection` prečíta `highlight` z URL,
                      odkryje skupinu/riadok (chip/„skryť vybavené") a zvýrazní ho. */}
                  <a
                    className="customer-contact-btn nedostupne-orders-link"
                    href={`?tab=orders&highlight=${encodeURIComponent(group.variantCode)}`}
                    data-testid={`nedostupne-orders-link-${group.variantCode}`}
                    aria-label={`Otvoriť ${itemLabel(group)} v Na objednanie`}
                    title="Otvoriť v Na objednanie"
                  >
                    <span aria-hidden="true">📦</span>
                  </a>
                  {/* issue 531: ručné označenie „vyriešené" — štvorček HNEĎ ZA
                      📦 (per Štěpánov nákres), vizuál konzistentný s checkboxom
                      „Objednané" v „Na objednanie" (`.nedostupne-group-header
                      input[type=checkbox]`). Viditeľný VŠETKÝM (ako 📦),
                      prepnúť smie len admin/manazer (`canControl`, server zápis
                      aj tak gated). „Nič ďalšie sa nestane, len sa to označí." */}
                  <input
                    type="checkbox"
                    className="nedostupne-resolved-checkbox"
                    data-testid={`nedostupne-resolved-checkbox-${group.variantCode}`}
                    aria-label={`Označiť ${itemLabel(group)} ako vyriešené`}
                    title="Vyriešené"
                    checked={group.resolved}
                    disabled={!canControl || resolvedBusy === group.variantCode}
                    onChange={(e) => {
                      toggleResolved(group.variantCode, e.target.checked);
                    }}
                  />
                </div>

                {/* issue 238: majiteľove RUČNE vložené odkazy náhrad — nahrádza
                    pôvodný automatický "Náhrada:" zoznam z `product.relatedCodes`
                    (majiteľ ho zamietol ako "súvisiace produkty, nie náhrady").
                    Zoznam je viditeľný VŠETKÝM (rovnaká úroveň ako čítanie
                    zvyšku karty); pridanie/zmazanie je gated na `canControl`. */}
                {group.replacementLinks.length > 0 && (
                  <ul className="nedostupne-replacement-links" data-testid={`nedostupne-replacement-links-${group.variantCode}`}>
                    {group.replacementLinks.map((link) => (
                      <li key={link.id} data-testid={`nedostupne-replacement-link-${link.id}`}>
                        <a href={link.url} target="_blank" rel="noreferrer">
                          {link.url}
                        </a>
                        {canControl && (
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={linkBusy === link.id}
                            onClick={() => {
                              removeLink(link.id);
                            }}
                            data-testid={`nedostupne-replacement-link-remove-${link.id}`}
                          >
                            ✕ zmazať
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {canControl && (
                  <div className="nedostupne-replacement-link-add">
                    <input
                      type="url"
                      placeholder="Odkaz na náhradný produkt (https://…)"
                      value={linkDrafts[group.variantCode] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLinkDrafts((drafts) => ({ ...drafts, [group.variantCode]: value }));
                      }}
                      aria-label={`Pridať odkaz náhrady pre ${itemLabel(group)}`}
                      data-testid={`nedostupne-replacement-link-input-${group.variantCode}`}
                    />
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={linkBusy === group.variantCode || (linkDrafts[group.variantCode] ?? "").trim() === ""}
                      onClick={() => {
                        addLink(group.variantCode);
                      }}
                      data-testid={`nedostupne-replacement-link-add-${group.variantCode}`}
                    >
                      + Pridať odkaz
                    </button>
                  </div>
                )}

                {group.orders.map((order) => {
                  const rowBusy = busyKey.startsWith(`${order.orderCode}|${group.variantCode}|`);
                  // issue 344: šéf chce riadok, kde už bol odoslaný AKÝKOĽVEK
                  // z dvoch e-mailov, odlíšiť na prvý pohľad — `handled`
                  // riadi celý riadok (background + ľavý pruh, `app.css`),
                  // nikdy len tlačidlo (zelená `--fs-success`). issue 466: šéf
                  // navyše chce SAMOTNÉ odoslané tlačidlo červené — každé z
                  // dvoch tlačidiel nižšie prepne `ghost` → `bad` (appkin
                  // červený button variant, `--fs-danger`) NEZÁVISLE podľa
                  // svojho vlastného sent flagu; riadok tým ostáva nedotknutý.
                  const handled = order.nedostupneSent || order.alternativaSent;
                  // issue 529: kľúč a zobrazovaná hodnota poznámky tohto riadku —
                  // rozpísaný draft má prednosť pred uloženou `order.comment`.
                  const noteKey = `${group.variantCode}|${order.orderCode}`;
                  const noteValue = noteDrafts[noteKey] ?? (order.comment ?? "");
                  const noteBusyHere = noteBusy === noteKey;
                  return (
                    <div
                      className={`nedostupne-order-row${handled ? " nedostupne-order-row--handled" : ""}`}
                      key={order.orderCode}
                      data-testid={`nedostupne-order-${order.orderCode}-${group.variantCode}`}
                      data-handled={handled ? "true" : "false"}
                    >
                      <a href={order.adminLink} target="_blank" rel="noreferrer">
                        {order.orderCode}
                      </a>
                      <span>{order.customerName}</span>
                      <span>{order.email === "" ? "(bez e-mailu)" : order.email}</span>
                      <span>{order.quantity} ks</span>
                      {/* issue 529: poznámka, ktorá sa zapíše ako poznámka
                          objednávky do eshopu (Shoptet) — rovnaká zapisovacia
                          cesta ako stĺpec POZNÁMKY v „Na objednanie". Vykreslenie
                          vyčlenené do `NedostupneOrderNote` (eslint max-lines). */}
                      {canControl && (
                        <NedostupneOrderNote
                          orderCode={order.orderCode}
                          variantCode={group.variantCode}
                          orderId={order.orderId}
                          value={noteValue}
                          busy={noteBusyHere}
                          // Uloženie nemá zmysel, keď sa poznámka nezmenila —
                          // zbytočný PUT + re-spustenie Shoptet writeback workera
                          // (code review nález, issue 529).
                          saveDisabled={noteBusyHere || noteValue.trim() === (order.comment ?? "")}
                          onChange={(value) => {
                            setNoteDrafts((drafts) => ({ ...drafts, [noteKey]: value }));
                          }}
                          onSave={(orderId, value) => {
                            saveNote(noteKey, order.orderCode, orderId, value);
                          }}
                        />
                      )}
                      {canControl && (
                        <div className="nedostupne-order-actions">
                          <button
                            type="button"
                            className={`btn lg ${order.nedostupneSent ? "bad" : "ghost"}`}
                            disabled={rowBusy || order.nedostupneSent}
                            onClick={() => {
                              openPreview(order.orderCode, group.variantCode, "nedostupne");
                            }}
                            data-testid={`nedostupne-send-${order.orderCode}-${group.variantCode}`}
                          >
                            {order.nedostupneSent ? "✓ Odoslané" : "Nedostupné — náhľad"}
                          </button>
                          <button
                            type="button"
                            className={`btn lg ${order.alternativaSent ? "bad" : "ghost"}`}
                            disabled={rowBusy || order.alternativaSent}
                            onClick={() => {
                              openPreview(order.orderCode, group.variantCode, "alternativa");
                            }}
                            data-testid={`nedostupne-alt-send-${order.orderCode}-${group.variantCode}`}
                          >
                            {order.alternativaSent ? "✓ Odoslané" : "S náhradou — náhľad"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* issue 191: náhľad je dialóg cez obrazovku, nie rozbalený blok na
          spodku stránky. Jednorazový `previewToken` z `/preview` ide ďalej
          nezmenený do `/send` (`.claude/rules/nedostupne.md`) — dialóg mení
          len to, KDE sa náhľad ukáže, nikdy nie to, že bez potvrdenia
          človekom e-mail neodíde. */}
      {pending !== null && (
        <MailPreviewDialog
          testId="nedostupne-preview"
          title="Náhľad e-mailu — povinné pred odoslaním"
          recipient={pending.preview.recipient}
          subject={pending.preview.subject}
          bodyText={editedBody}
          onBodyTextChange={setEditedBody}
          confirmLabel="📧 Odoslať zákazníkovi"
          confirmDisabled={busyKey !== "" || editedBody.trim() === ""}
          onConfirm={confirmSend}
          returnFocusRef={triggerRef}
          onClose={() => {
            setPending(null);
          }}
        />
      )}
    </section>
  );
}
