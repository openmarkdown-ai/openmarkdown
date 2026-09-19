// Community-plugin compatibility runner.
// Usage: node e2e/compat/run.mjs <bundles-dir> <out-dir> [scenario ...]
//   COMPAT_URL=http://localhost:5200/ (default) — the built app (node e2e/server.mjs)
// Each scenario is e2e/compat/<name>.mjs exporting
//   default { plugins: string[], run({ page, check, shot, errors, bundles, out }) }.
// Results (checks, errors) are printed and written to <out-dir>/compat-results.json.
import { readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Checks, launch, openVault } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [bundles, out, ...names] = process.argv.slice(2);
if (!bundles || !out) {
  console.error("usage: node e2e/compat/run.mjs <bundles-dir> <out-dir> [scenario ...]");
  process.exit(2);
}
const all = readdirSync(here).filter((f) => f.endsWith(".mjs") && !["lib.mjs", "run.mjs"].includes(f)).map((f) => f.slice(0, -4));
const selected = names.length ? names : all;
const resultsPath = join(out, "compat-results.json");
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
const browser = await launch();
let failed = 0;
for (const name of selected) {
  const scenario = (await import(join(here, `${name}.mjs`))).default;
  console.log(`\n== ${name}`);
  const check = new Checks(name);
  const { context, page, errors, loaded } = await openVault(browser, bundles, scenario.plugins, scenario.options ?? {});
  for (const [id, ok] of Object.entries(loaded)) check.ok(`loads ${id}`, ok === true, ok === true ? "" : ok);
  let n = 0;
  const shot = async (label) => {
    const path = join(out, `${name}-${++n}-${label}.png`);
    await page.screenshot({ path });
    return path;
  };
  try {
    await scenario.run({ page, check, shot, errors, bundles, out });
  } catch (e) {
    check.ok("scenario completed", false, (e && e.stack) || e);
    await shot("crash").catch(() => {});
  }
  const pageErrors = errors.filter((e) => !(scenario.ignoreErrors ?? []).some((re) => re.test(e)));
  check.ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  for (const e of pageErrors.slice(0, 8)) console.log("   " + e);
  const fails = check.results.filter((r) => !r.pass).length;
  failed += fails;
  results[name] = { at: new Date().toISOString(), passed: check.passed, total: check.results.length, checks: check.results, errors: pageErrors.slice(0, 20) };
  console.log(`== ${name}: ${check.passed}/${check.results.length}`);
  await context.close();
}
await browser.close();
writeFileSync(resultsPath, JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
