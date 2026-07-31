import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-types/**", "**/node_modules/**", "**/*.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "apps/api/*.config.ts",
            "apps/web/*.config.ts",
            // "apps/web/tests/e2e/*.ts" REMOVED (issue 95) — the directory now
            // has its own real tsconfig.json (needed "DOM" lib for
            // `page.evaluate()` callbacks referencing `document`/`window`,
            // which the API's default project's Node-only `lib` doesn't have)
            // wired into root `typecheck`; project service finds it on its
            // own, same reason as the two removals below.
            // "scripts/*.ts" REMOVED (final-wave-b, item 1/issue #4) — scripts/
            // now has its own real tsconfig (`scripts/tsconfig.json`, wired into
            // `pnpm typecheck`), so typescript-eslint's project service finds it
            // on its own; leaving the glob here errors ("was included by
            // allowDefaultProject but also was found in the project service").
            //
            // "apps/api/tests/*.ts" + "apps/api/tests/helpers/*.ts" REMOVED
            // (issue #4, remaining half) — same reason: apps/api/tests/ now has
            // its own real tsconfig.json, wired into `pnpm typecheck`.
          ],
          defaultProject: "apps/api/tsconfig.eslint.json",
          // The monorepo now has two packages, each with a handful of standalone
          // config/test-helper files that fall back to the default project (see
          // allowDefaultProject above). More packages/tasks will add a few more.
          // This is the documented escape hatch for that growth, not a workaround
          // for a bug — https://tseslint.com/allowdefaultproject-glob-too-wide
          // F1 pridáva ďalšie samostatné testy/skripty mimo TS projektov
          // (apps/api/tests/*.ts, scripts/*.ts). Pri 20 by lint spadol na strope,
          // nie na skutočnej chybe.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 40,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
);
