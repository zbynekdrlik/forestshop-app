// issue 173: "Pripomienky objednávok" — konštanty prevzaté zo starej appky
// (`parovanie_produktov/src/parovanie/orders_reminder.py`), preto komentáre na
// viacerých miestach citujú presne odtiaľ.

// n8n/stará appka: date before now.minus(4, 'days').
export const MIN_DAYS = 4;

// Stará appky's typo "Foresthop" opravený (rovnaký fix ako
// `orders_reminder.py`'s vlastný komentár k tomu).
export const EMAIL_SUBJECT = "📦 Stav vašej objednávky z Forestshop.sk";

// Klasifikátorove dve kategórie (verbatim z n8n "Kontaktovany?" node) —
// použité AJ v prompte, AJ ako jediné povolené výstupné hodnoty.
export const CATEGORY_CONTACTED = "kontaktovany";
export const CATEGORY_NOT_CONTACTED = "nekontaktovany";

// Ďalší voľný advisory-lock kľúč v registri `.claude/rules/scheduler.md`
// (787_878_001/002/003/004/100 sú obsadené, `.claude/rules/posta-uncollected
// .md` + `.claude/rules/testing.md`) — serializuje CELÝ beh (naplánovaný,
// "Spustiť teraz" AJ každú ručnú per-riadkovú akciu), rovnaký zámer ako
// `POSTA_UNCOLLECTED_RUN_LOCK_KEY`, viď návrhový komentár na issue 173.
export const ORDER_REMINDER_RUN_LOCK_KEY = 787_878_005;
