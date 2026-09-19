// Downloads the unmodified community plugin releases the compatibility scenarios run against
// (`e2e/compat/run.mjs <bundles-dir> <out-dir>`), and the Minimal theme the Style Settings
// scenario needs at `<bundles-dir>/../obsidian-minimal/theme.css`.
//
// Usage: node scripts/fetch-plugin-bundles.mjs <bundles-dir>
//
// Versions are pinned to the ones docs/plugin-compatibility.md reports, so a rerun tests the same
// code; a plugin with no pinned version takes its latest release (and says so).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PINNED = {
  dataview: "0.5.68",
  "obsidian-tasks-plugin": "8.4.0",
  calendar: "1.5.10",
  "table-editor-obsidian": "0.23.2",
  "obsidian-outliner": "4.10.2",
  "obsidian-linter": "1.33.0",
  "editing-toolbar": "4.1.4",
  "templater-obsidian": "2.25.0",
  quickadd: "2.25.0",
  "obsidian-kanban": "2.0.51",
  "obsidian-excalidraw-plugin": "2.27.3",
  "tag-wrangler": "0.6.5",
  "recent-files-obsidian": "1.7.10",
  homepage: "4.5.0",
  "obsidian-style-settings": "1.0.9",
  "obsidian-minimal-settings": "9.0.0",
  omnisearch: "1.31.0",
  "obsidian-importer": "3.1.5",
  "remotely-save": "0.5.25",
  copilot: "4.0.8",
  "smart-connections": "4.7.2",
  tasknotes: "4.13.0",
  "obsidian-git": "2.39.0",
  "obsidian-icon-folder": null,
};

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/fetch-plugin-bundles.mjs <bundles-dir>");
  process.exit(1);
}
const bundles = resolve(out);
mkdirSync(bundles, { recursive: true });

async function get(url, { optional = false } = {}) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "openmarkdown-compat" } });
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const registry = JSON.parse((await get("https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json")).toString("utf8"));
const repoFor = new Map(registry.map((p) => [p.id, p.repo]));

let failed = 0;
for (const [id, pinned] of Object.entries(PINNED)) {
  const repo = repoFor.get(id);
  if (!repo) {
    console.error(`${id}: not in the community plugin registry`);
    failed++;
    continue;
  }
  let version = pinned;
  if (!version) {
    const latest = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases/latest`)).toString("utf8"));
    version = latest.tag_name;
    console.log(`${id}: no pinned version, using latest ${version}`);
  }
  const dir = join(bundles, id);
  mkdirSync(dir, { recursive: true });
  try {
    for (const file of ["manifest.json", "main.js", "styles.css"]) {
      const data = await get(`https://github.com/${repo}/releases/download/${version}/${file}`, { optional: file === "styles.css" });
      if (data) writeFileSync(join(dir, file), data);
    }
    console.log(`${id} ${version} ← ${repo}`);
  } catch (e) {
    console.error(`${id}: ${e.message}`);
    failed++;
  }
}

// The Minimal theme (kepano/obsidian-minimal), for the Style Settings scenario.
const minimal = join(dirname(bundles), "obsidian-minimal");
mkdirSync(minimal, { recursive: true });
try {
  for (const file of ["theme.css", "manifest.json"]) {
    writeFileSync(join(minimal, file), await get(`https://raw.githubusercontent.com/kepano/obsidian-minimal/master/${file}`));
  }
  console.log(`Minimal theme → ${join(minimal, "theme.css")}`);
} catch (e) {
  console.error(`Minimal theme: ${e.message}`);
  failed++;
}

if (failed) {
  console.error(`${failed} download(s) failed`);
  process.exit(1);
}
if (!existsSync(join(bundles, "dataview", "main.js"))) process.exit(1);
