// @ts-check
import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "data/**", "eval/results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue SFCs: error-prevention rules only (formatting is Prettier's job).
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] } },
    // Type-checked by vue-tsc; core no-undef does not know browser/TS globals in SFCs.
    rules: { "no-undef": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
);
