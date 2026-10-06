import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

// The console is a static SPA and just another client of the gateway (docs/06). It reads VITE_* from the
// repo-root .env. Locally, if VITE_DEMO_TENANTS is not set, it is derived from the seed keys of the three
// PUBLIC demo tenants (acme, globex, tiny); the reviewer key is never bundled. The admin key never is either.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const derived = [
    ["acme (pro, debug)", env["SEED_KEY_ACME"]],
    ["globex (restricted)", env["SEED_KEY_GLOBEX"]],
    ["tiny (low quota)", env["SEED_KEY_TINY"]],
  ]
    .filter(([, key]) => key)
    .map(([name, key]) => ({ name, key }));
  return {
    envDir: "../..",
    plugins: [vue(), tailwindcss()],
    define: env["VITE_DEMO_TENANTS"]
      ? {}
      : { "import.meta.env.VITE_DEMO_TENANTS": JSON.stringify(JSON.stringify(derived)) },
    server: { port: 5173 },
  };
});
