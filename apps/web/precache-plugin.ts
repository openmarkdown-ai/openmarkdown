/**
 * Offline app shell: tells the service worker which files make up this build.
 *
 * At the end of `vite build` every emitted file (HTML, JS/CSS chunks including
 * lazy ones, wasm, workers, fonts) plus the public directory (manifest, icons)
 * is listed with a content hash. The list and a build id derived from it are
 * written into `sw.js` in place of `self.__OM_PRECACHE__`, and the build id
 * into `index.html` as `<meta name="openmarkdown-build">`, so a page can tell
 * the worker which build it runs and the worker keeps that build's files
 * while any tab still uses them.
 *
 * In `vite` (dev) the worker is served from `src/sw.ts` untransformed apart
 * from TypeScript, with no manifest: it precaches nothing and only answers
 * vault resources and share-target posts.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const PLACEHOLDER = "self.__OM_PRECACHE__";
/** Files never precached: source maps, and anything very large a user may never need. */
const SKIP = [/\.map$/, /^sw\.js$/, /(^|\/)\.DS_Store$/];
/**
 * Downloads the user must agree to first (docs/PLAN-daily.md principle 6): OCR,
 * grammar, document conversion, on-device models. Not precached; the worker
 * caches them the first time they are fetched, so they work offline after that.
 */
// Sync (its lazy chunk and 1.2 MB wasm) is only for vaults that turn it on.
const OPTIONAL = [/tesseract/i, /harper/i, /pandoc/i, /onnx|ort-wasm/i, /transformers/i, /whisper/i, /opensync/i];
/**
 * Chunks built from these modules are also left to the runtime cache: reveal.js
 * presentation themes (four embed their fonts, ~430 KB gzip each) and CSL
 * citation styles — only the one a user picks is ever loaded.
 */
const OPTIONAL_MODULES = [/[\\/]opensync[\\/]/, /reveal\.js[\\/]dist[\\/]theme[\\/]/, /[\\/]csl-styles?[\\/]|\.csl(\?|$)/];
const MAX_PRECACHE_BYTES = 8 * 1024 * 1024;

function hash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function precacheManifest(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "openmarkdown-precache",
    enforce: "post",
    configResolved(c) {
      config = c;
    },
    configureServer(server) {
      // Serve the worker in dev so vault resources and the share target work there too.
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== "/sw.js") return next();
        try {
          const result = await server.transformRequest("/src/sw.ts");
          if (!result) return next();
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end(result.code);
        } catch (e) {
          next(e);
        }
      });
    },
    generateBundle(_options, bundle) {
      const files = new Map<string, string>();
      let html: { fileName: string; source: string } | null = null;
      for (const [fileName, item] of Object.entries(bundle)) {
        if (SKIP.some((re) => re.test(fileName)) || OPTIONAL.some((re) => re.test(fileName))) continue;
        if (item.type === "chunk" && item.moduleIds.length && item.moduleIds.every((id) => OPTIONAL_MODULES.some((re) => re.test(id)))) continue;
        const content = item.type === "chunk" ? item.code : typeof item.source === "string" ? item.source : item.source;
        if (content.length > MAX_PRECACHE_BYTES) continue;
        if (fileName === "index.html" && item.type === "asset") {
          html = { fileName, source: String(item.source) };
          continue;
        }
        files.set(fileName, hash(content));
      }
      const publicDir = config.publicDir ? resolve(config.publicDir) : "";
      if (publicDir) {
        for (const full of walk(publicDir)) {
          const rel = relative(publicDir, full).split("\\").join("/");
          if (SKIP.some((re) => re.test(rel)) || files.has(rel)) continue;
          files.set(rel, hash(readFileSync(full)));
        }
      }
      const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
      const buildId = hash(JSON.stringify(sorted) + (html?.source ?? "")).slice(0, 12);

      if (html) {
        const meta = `<meta name="openmarkdown-build" content="${buildId}" />`;
        const source = html.source.includes("</head>") ? html.source.replace("</head>", `  ${meta}\n  </head>`) : meta + html.source;
        (bundle[html.fileName] as { source: string }).source = source;
        sorted.push([html.fileName, hash(source)]);
      }

      const sw = bundle["sw.js"];
      if (!sw || sw.type !== "chunk") {
        this.warn("sw.js not found in the bundle; the app shell will not be precached.");
        return;
      }
      if (!sw.code.includes(PLACEHOLDER)) {
        this.warn(`${PLACEHOLDER} not found in sw.js; the app shell will not be precached.`);
        return;
      }
      const manifest = { buildId, builtAt: Date.now(), files: sorted };
      sw.code = sw.code.split(PLACEHOLDER).join(`(${JSON.stringify(manifest)})`);
    },
  };
}
