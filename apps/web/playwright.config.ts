import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5173", trace: "on-first-retry" },
  webServer: [
    {
      command: "pnpm exec tsx ../../scripts/e2e-setup.ts && pnpm --filter @forestshop/api start",
      url: "http://127.0.0.1:3000/api/version",
      reuseExistingServer: false,
      env: { SESSION_COOKIE_SECURE: "false" },
    },
    {
      command: "pnpm --filter @forestshop/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
