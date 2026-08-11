import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // issue 351: dev1 (4 jadrá/7 GB) beží zdieľaný s ďalšími reláciami/
  // projektmi — mimo CI preto e2e beží na JEDEN worker (žiadne súbežné
  // Chromium procesy), aby prípadný manuálny lokálny beh (tiket priamo
  // dotýkajúci sa obrazoviek) nezdvojnásobil zaťaženie. V CI (`process.env.CI`,
  // GitHub Actions ho nastavuje automaticky) ostáva predvolený počet.
  workers: process.env.CI ? undefined : 1,
  use: { baseURL: "http://127.0.0.1:5173", trace: "on-first-retry" },
  webServer: [
    {
      command: "pnpm exec tsx ../../scripts/e2e-setup.ts && pnpm --filter @forestshop/api start",
      url: "http://127.0.0.1:3000/api/version",
      reuseExistingServer: false,
      // Celý E2E balík sa prihlasuje z JEDNEJ adresy (localhost) — okolo 30
      // prihlásení za beh, čo je presne strop `IP_MAX_ATTEMPTS`
      // (`login-rate-limit.ts`). Bez zdvihnutia by ktorýkoľvek ĎALŠÍ pridaný
      // test zhodil NÁHODNÝ neskorší spec súbor hláškou "Nesprávny e-mail
      // alebo heslo" (issue 192). Limit na (IP, e-mail) pár — ten, čo chráni
      // konkrétny účet — ostáva nezmenený, aj v testoch.
      env: { SESSION_COOKIE_SECURE: "false", LOGIN_IP_MAX_ATTEMPTS: "500" },
    },
    {
      command: "pnpm --filter @forestshop/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
