/**
 * The vault's vocabulary for word completion: every word of 4+ letters in the
 * vault's Markdown files, with how often it occurs. Built lazily the first
 * time completion asks for it (reading files through `cachedRead`, yielding to
 * the event loop between batches), then kept current on modify/delete/rename.
 * Nothing leaves the device.
 *
 * Host-agnostic: it only needs a vault-like object, so the editor module can
 * own it without importing the app.
 */

export interface VocabularyVault {
  getMarkdownFiles(): { path: string }[];
  cachedRead(file: { path: string }): Promise<string>;
  on(name: string, cb: (...args: any[]) => void): unknown;
}

const WORD_RE = /\p{L}[\p{L}\p{M}]{3,}/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const MAX_WORD = 40;

/** Words (≥4 letters, no CJK runs, no URLs or code spans) of `text` with counts. */
export function countWords(text: string, into = new Map<string, number>()): Map<string, number> {
  const cleaned = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of cleaned.matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length > MAX_WORD || CJK_RE.test(w)) continue;
    into.set(w, (into.get(w) ?? 0) + 1);
  }
  return into;
}

const cache = new WeakMap<object, Promise<Map<string, number>>>();

function add(total: Map<string, number>, part: Map<string, number>, sign: 1 | -1) {
  for (const [w, n] of part) {
    const next = (total.get(w) ?? 0) + sign * n;
    if (next > 0) total.set(w, next);
    else total.delete(w);
  }
}

/** The vocabulary of `vault`, built once per vault object. */
export function vaultVocabulary(vault: VocabularyVault): Promise<Map<string, number>> {
  const existing = cache.get(vault);
  if (existing) return existing;
  const promise = (async () => {
    const total = new Map<string, number>();
    const perFile = new Map<string, Map<string, number>>();
    const index = async (file: { path: string }) => {
      let text = "";
      try {
        text = await vault.cachedRead(file);
      } catch {
        return;
      }
      const old = perFile.get(file.path);
      if (old) add(total, old, -1);
      const counts = countWords(text);
      perFile.set(file.path, counts);
      add(total, counts, 1);
    };
    const isMd = (f: { path: string } | null | undefined) => !!f && /\.md$/i.test(f.path);
    vault.on("modify", (f: { path: string }) => isMd(f) && void index(f));
    vault.on("create", (f: { path: string }) => isMd(f) && void index(f));
    vault.on("delete", (f: { path: string }) => {
      const old = perFile.get(f?.path);
      if (old) add(total, old, -1);
      perFile.delete(f?.path);
    });
    vault.on("rename", (f: { path: string }, oldPath: string) => {
      const old = perFile.get(oldPath);
      if (!old) return;
      perFile.delete(oldPath);
      perFile.set(f.path, old);
    });
    const files = vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      await index(files[i]!);
      if (i % 40 === 39) await new Promise((r) => setTimeout(r, 0));
    }
    return total;
  })();
  cache.set(vault, promise);
  return promise;
}
