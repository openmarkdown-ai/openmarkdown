// Builds the extension twice: dist/ (Chromium, MV3 service worker, side panel,
// offscreen document) and dist-firefox/ (MV3 event page, sidebar). esbuild
// bundles every entry; the wasm engine is copied from packages/engine.
//
//   node build.mjs              both targets
//   node build.mjs chromium     one target
//   node build.mjs --watch      rebuild on change (Chromium only)
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const productSrc = readFileSync(join(repo, "packages/app/src/product.ts"), "utf8");
const PRODUCT_NAME = /PRODUCT_NAME = "([^"]+)"/.exec(productSrc)?.[1] ?? "OpenMarkdown";
const PRODUCTION_ORIGIN = "https://openmarkdown.ai";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const targets = args.filter((a) => !a.startsWith("--"));
const wanted = targets.length ? targets : watch ? ["chromium"] : ["chromium", "firefox"];

const pages = [
  { name: "clipper", title: `${PRODUCT_NAME} Clipper`, mode: "popup" },
  { name: "sidepanel", entry: "clipper", title: `${PRODUCT_NAME} Clipper`, mode: "sidepanel" },
  { name: "options", title: `${PRODUCT_NAME} Clipper settings` },
  { name: "reader", title: "Reader view" },
  { name: "consent", title: "Allow network requests" },
  { name: "offscreen", title: "Clipper engine", chromiumOnly: true },
];

function manifest(firefox) {
  const icons = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
  const m = {
    manifest_version: 3,
    name: `${PRODUCT_NAME} Clipper`,
    short_name: "Clipper",
    version: pkg.version,
    description: `Clip web pages into ${PRODUCT_NAME}, highlight passages, read without clutter, and let the app's plugins reach sites that block web pages.`,
    icons,
    action: { default_popup: "clipper.html", default_title: `Clip to ${PRODUCT_NAME}`, default_icon: icons },
    options_ui: { page: "options.html", open_in_tab: true },
    permissions: ["activeTab", "scripting", "storage", "contextMenus", "clipboardWrite", "declarativeNetRequestWithHostAccess"],
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
    optional_host_permissions: ["<all_urls>"],
    commands: {
      _execute_action: { suggested_key: { default: "Ctrl+Shift+O", mac: "Command+Shift+O" }, description: "Open the clipper" },
      quick_clip: { suggested_key: { default: "Alt+Shift+O", mac: "Alt+Shift+O" }, description: "Quick clip with the matching template" },
      toggle_highlighter: { suggested_key: { default: "Alt+Shift+H", mac: "Alt+Shift+H" }, description: "Toggle the highlighter" },
      toggle_reader: { suggested_key: { default: "Alt+Shift+R", mac: "Alt+Shift+R" }, description: "Toggle reader view" },
    },
    web_accessible_resources: [
      { resources: ["reader.html", "pages/reader.js", "pages/reader.css", "pages/*.woff2"], matches: ["<all_urls>"] },
    ],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  };
  if (firefox) {
    m.background = { scripts: ["background.js"] };
    m.sidebar_action = { default_panel: "sidepanel.html", default_title: `${PRODUCT_NAME} Clipper`, default_icon: icons, open_at_install: false };
    m.browser_specific_settings = { gecko: { id: "clipper@openmarkdown.ai", strict_min_version: "128.0" } };
  } else {
    m.background = { service_worker: "background.js" };
    m.side_panel = { default_path: "sidepanel.html" };
    m.permissions.push("sidePanel", "offscreen");
    m.minimum_chrome_version = "116";
    m.externally_connectable = { matches: ["http://localhost/*", "http://127.0.0.1/*", `${PRODUCTION_ORIGIN}/*`] };
  }
  return m;
}

function html(page, firefox) {
  const entry = page.entry ?? page.name;
  return `<!doctype html>
<html lang="en" class="oa-auto" data-mode="${page.mode ?? ""}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<link rel="icon" href="icons/icon-32.png">
${entry === "offscreen" ? "" : `<link rel="stylesheet" href="pages/${entry}.css">`}
</head>
<body data-mode="${page.mode ?? ""}" data-browser="${firefox ? "firefox" : "chromium"}">
<div id="app"></div>
<script type="module" src="pages/${entry}.js"></script>
</body>
</html>
`;
}

function options(firefox, outdir) {
  const common = {
    bundle: true,
    target: firefox ? ["firefox128"] : ["chrome116"],
    define: { __FIREFOX__: String(firefox) },
    alias: { "@vault/engine": join(repo, "packages/engine/src/index.ts") },
    loader: { ".svg": "text", ".woff2": "file" },
    legalComments: "none",
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    logLevel: "warning",
    logOverride: { "empty-import-meta": "silent" },
  };
  const pageEntries = [...new Set(pages.filter((p) => !(firefox && p.chromiumOnly)).map((p) => p.entry ?? p.name))];
  return [
    { ...common, entryPoints: Object.fromEntries(pageEntries.map((e) => [e, join(here, `src/pages/${e}.ts`)])), outdir: join(outdir, "pages"), format: "esm", assetNames: "[name]" },
    { ...common, entryPoints: { background: join(here, "src/background/index.ts") }, outdir, format: "iife" },
    {
      ...common,
      entryPoints: {
        "app-bridge": join(here, "src/content/app-bridge.ts"),
        highlighter: join(here, "src/content/highlighter.ts"),
        reader: join(here, "src/content/reader.ts"),
      },
      outdir: join(outdir, "content"),
      format: "iife",
    },
  ];
}

function writeStatic(firefox, outdir) {
  mkdirSync(join(outdir, "wasm"), { recursive: true });
  cpSync(join(repo, "packages/engine/src/wasm-gen/vault_wasm_bg.wasm"), join(outdir, "wasm/vault_wasm_bg.wasm"));
  cpSync(join(here, "public/icons"), join(outdir, "icons"), { recursive: true });
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest(firefox), null, 2) + "\n");
  for (const p of pages) if (!(firefox && p.chromiumOnly)) writeFileSync(join(outdir, `${p.name}.html`), html(p, firefox));
}

for (const target of wanted) {
  const firefox = target === "firefox";
  const outdir = join(here, firefox ? "dist-firefox" : "dist");
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  writeStatic(firefox, outdir);
  if (watch) {
    for (const o of options(firefox, outdir)) await (await context(o)).watch();
    console.log(`watching → ${outdir}`);
  } else {
    await Promise.all(options(firefox, outdir).map((o) => build(o)));
    console.log(`built ${target} → ${outdir}`);
  }
}
