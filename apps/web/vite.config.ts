import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { precacheManifest } from "./precache-plugin";

// Sync (W7): the OpenSync client, reached by relative path in a sibling
// checkout. A clone without ../opensync builds without sync: the aliases point
// at a stub and the Sync UI stays hidden. Never a vendored copy.
const OPENSYNC_CLIENT = resolve(__dirname, "../../../opensync/packages/client/src");
const OPENSYNC_STUB = resolve(__dirname, "../../packages/app/src/core-plugins/opensync/unavailable");
const hasOpenSync = existsSync(resolve(OPENSYNC_CLIENT, "vault.ts"));
if (!hasOpenSync) console.warn("[openmarkdown] ../opensync not found: building without sync");

// A static site: one HTML entry, hashed JS/CSS chunks, one wasm file, and a
// service worker. `base: "./"` so the build runs from any subdirectory.
export default defineConfig({
  root: resolve(__dirname),
  base: "./",
  plugins: [precacheManifest()],
  resolve: {
    alias: {
      "@vault/engine": resolve(__dirname, "../../packages/engine/src/index.ts"),
      "@vault/app": resolve(__dirname, "../../packages/app/src"),
      "@opensync/client": hasOpenSync ? resolve(OPENSYNC_CLIENT, "index.ts") : resolve(OPENSYNC_STUB, "index.ts"),
      "@opensync/wasm": hasOpenSync ? resolve(OPENSYNC_CLIENT, "wasm") : resolve(OPENSYNC_STUB, "wasm"),
      "@opensync/in-build": resolve(__dirname, "../../packages/app/src/core-plugins/opensync", hasOpenSync ? "in-build.ts" : "unavailable/in-build.ts"),
      "./wasm/inline": resolve(__dirname, "../../packages/app/src/core-plugins/opensync/no-inline-wasm.ts"),
    },
    dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  },
  // harper.js finds its wasm via `new URL(…, import.meta.url)`; pre-bundling would break that.
  optimizeDeps: { exclude: ["harper.js"] },
  server: { port: 5200, strictPort: true, fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(hasOpenSync ? [OPENSYNC_CLIENT] : [])] } },
  preview: { port: 5200, strictPort: true },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // account.html is its own page (served at `<app>/account`): the sign-in
      // redirect leaves and re-enters the window, so it must never run on the
      // page holding an open vault.
      input: { main: resolve(__dirname, "index.html"), account: resolve(__dirname, "account.html"), sw: resolve(__dirname, "src/sw.ts") },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
