import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "apps/api/*.config.ts",
            "apps/api/tests/*.ts",
            "apps/api/tests/helpers/*.ts",
            "scripts/*.ts",
          ],
          defaultProject: "apps/api/tsconfig.eslint.json",
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
