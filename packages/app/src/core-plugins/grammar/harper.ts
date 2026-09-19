/**
 * Harper (harper.js, Apache-2.0) loaded on demand. This module is only ever
 * reached through a dynamic `import()`, so neither its JS (~150 KB) nor the
 * 16 MB "slim" wasm is part of the main bundle; the wasm is fetched the first
 * time grammar check runs and then comes from the HTTP cache.
 *
 * The package locates its wasm with `new URL(…, import.meta.url)`, which Vite's
 * dev-time dependency pre-bundling would break, so `apps/web/vite.config.ts`
 * excludes harper.js from `optimizeDeps`.
 */
import type { GrammarIssue } from "../../editor/grammar-lint";
import type { Linter, Lint } from "harper.js";

export interface HarperChecker {
  lint(text: string): Promise<GrammarIssue[]>;
  addWords(words: string[]): Promise<void>;
  dispose(): Promise<void>;
  kind: "worker" | "local";
}

/** Harper spans count Unicode scalar values; the editor counts UTF-16 units. */
function charToUtf16(text: string): ((i: number) => number) | null {
  if (!/[\uD800-\uDFFF]/.test(text)) return null;
  const map: number[] = [];
  let u = 0;
  for (const ch of text) {
    map.push(u);
    u += ch.length;
  }
  map.push(u);
  return (i) => map[Math.max(0, Math.min(map.length - 1, i))]!;
}

export async function loadHarper(): Promise<HarperChecker> {
  const harper = await import("harper.js");
  const { slimBinary } = await import("harper.js/slimBinary");
  let linter: Linter;
  let kind: "worker" | "local" = "worker";
  try {
    linter = new harper.WorkerLinter({ binary: slimBinary as never, dialect: harper.Dialect.American });
    await withTimeout(linter.setup(), 60_000);
  } catch (e) {
    console.warn("Harper worker unavailable, linting on the main thread", e);
    kind = "local";
    linter = new harper.LocalLinter({ binary: slimBinary as never, dialect: harper.Dialect.American });
    await linter.setup();
  }
  const KIND_NAMES: Record<number, "replace" | "remove" | "insert"> = { 0: "replace", 1: "remove", 2: "insert" };
  return {
    kind,
    async lint(text) {
      const lints: Lint[] = await linter.lint(text, { language: "markdown" });
      const conv = charToUtf16(text);
      const out: GrammarIssue[] = [];
      for (const l of lints) {
        const span = l.span();
        const from = conv ? conv(span.start) : span.start;
        const to = conv ? conv(span.end) : span.end;
        out.push({
          from,
          to,
          message: l.message(),
          kind: l.lint_kind_pretty?.() || l.lint_kind(),
          problem: text.slice(from, to),
          suggestions: l.suggestions().map((s) => ({ text: s.get_replacement_text(), kind: KIND_NAMES[Number(s.kind())] ?? "replace" })),
        });
      }
      return out;
    },
    async addWords(words) {
      if (words.length) await linter.importWords(words);
    },
    async dispose() {
      await linter.dispose();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
