/**
 * Adapts the wasm-bindgen exports (JSON strings in, JSON strings out) to the
 * typed `Engine` interface. Changes together with crates/vault-wasm/src/lib.rs.
 */
import type { Engine, ForceLayoutHandle, PublishFile, VaultIndexHandle } from "./index";
import type { WasmExports } from "./wasm-types";

function parse<T>(json: string | undefined | null): T {
  return (json === undefined || json === null ? null : JSON.parse(json)) as T;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Publish inputs cross as JSON: attachment bytes become base64. */
function publishInput<T extends { files: PublishFile[] }>(input: T): unknown {
  return { ...input, files: input.files.map((f) => (f.bytes ? { ...f, bytes: toBase64(f.bytes) } : f)) };
}

function need(w: WasmExports, name: string): (...args: any[]) => any {
  const fn = w[name];
  if (typeof fn !== "function") {
    return () => {
      throw new Error(`vault engine: "${name}" is not available in this build`);
    };
  }
  return fn;
}

export function bindEngine(w: WasmExports): Engine {
  const memory = () => (w.__wasm ?? w).memory as WebAssembly.Memory | undefined;

  const createIndex = (): VaultIndexHandle => {
    const idx = new w.Index();
    return {
      upsertFile: (e) => idx.upsert_file(JSON.stringify(e)),
      removeFile: (p) => idx.remove_file(p),
      renameFile: (a, b) => idx.rename_file(a, b),
      setNote: (p, t) => parse(idx.set_note(p, t)),
      resolveLink: (l, s) => idx.resolve_link(l, s) ?? null,
      resolvedLinks: () => parse(idx.resolved_links()),
      unresolvedLinks: () => parse(idx.unresolved_links()),
      backlinks: (p) => parse(idx.backlinks(p)),
      unlinkedMentions: (p) => parse(idx.unlinked_mentions(p)),
      tags: () => parse(idx.tags()),
      linktext: (t, s, f) => idx.linktext(t, s, f),
      renameEdits: (a, b, o) => parse(idx.rename_edits(a, b, o.linkFormat ?? "shortest")),
      search: (q, o) => parse(idx.search(q, JSON.stringify(o ?? {}))),
      graph: (o) => parse(idx.graph(JSON.stringify(o ?? {}))),
      outgoing: (p) => {
        const resolved = (parse<Record<string, Record<string, number>>>(idx.resolved_links())[p] ?? {}) as Record<string, number>;
        const unresolved = (parse<Record<string, Record<string, number>>>(idx.unresolved_links())[p] ?? {}) as Record<string, number>;
        return { resolved, unresolved };
      },
      free: () => idx.free(),
    };
  };

  const createForceLayout = (ids: string[], links: Uint32Array, params: object): ForceLayoutHandle => {
    const layout = new w.Layout(JSON.stringify(ids), links, JSON.stringify(params ?? {}));
    return {
      step: (n) => layout.step(n),
      positions: () => {
        const mem = memory();
        const ptr = layout.positions_ptr();
        const len = layout.positions_len();
        return mem ? new Float32Array(mem.buffer, ptr, len) : new Float32Array(len);
      },
      setParams: (p) => layout.set_params(JSON.stringify(p)),
      pin: (i, x, y) => layout.pin(i, x, y),
      unpin: (i) => layout.unpin(i),
      reheat: (a) => layout.reheat(a),
      alpha: () => layout.alpha(),
      setGraph: (newIds, newLinks) => layout.set_graph(JSON.stringify(newIds), newLinks),
      free: () => layout.free(),
    };
  };

  return {
    parse: (t) => parse(need(w, "parse")(t)),
    render: (t, o) => parse(need(w, "render")(t, !!o.strictLineBreaks)),
    wordCount: (t) => parse(need(w, "word_count")(t)),
    yamlParse: (s) => {
      const r = parse<{ value?: unknown; error?: string }>(need(w, "yaml_parse")(s));
      if (r.error) throw new Error(r.error);
      return r.value;
    },
    yamlStringify: (v) => need(w, "yaml_stringify")(JSON.stringify(v)),
    resolveSubpath: (m, s) => parse(need(w, "resolve_subpath")(JSON.stringify(m), s)),
    fuzzy: (q, t) => parse(w.fuzzy(q, t)),
    simpleSearch: (q, t) => parse(w.simple_search(q, t)),
    rank: (q, items, limit) => parse(w.rank(q, JSON.stringify(items), limit)),
    htmlToMarkdown: (h, b) => need(w, "html_to_markdown")(h, b ?? ""),
    extract: (h, u) => parse(need(w, "extract")(h, u)),
    renderTemplate: (t, c) => parse(need(w, "render_template")(t, JSON.stringify(c))),
    clipPage: (templateJson, input) => parse(need(w, "clip_page")(templateJson, JSON.stringify(input))),
    formatConvert: (t, o) => need(w, "format_convert")(t, JSON.stringify(o)),
    createIndex,
    createForceLayout,
    bases: {
      parse: (y) => parse(need(w, "bases_parse")(y)),
      serialize: (b) => need(w, "bases_serialize")(JSON.stringify(b)),
      runView: (b, v, files, thisFile, now, tz) =>
        parse(need(w, "bases_run_view")(JSON.stringify(b), v, JSON.stringify(files), JSON.stringify(thisFile), now, tz)),
      eval: (e, c) => parse(need(w, "bases_eval")(e, JSON.stringify(c))),
    },
    publish: {
      exportNote: (i) => need(w, "publish_note")(JSON.stringify(publishInput(i))),
      exportSite: (i) => {
        const res = parse<{ path: string; data: string }[] | { error: string }>(need(w, "publish_site")(JSON.stringify(publishInput(i))));
        if (!Array.isArray(res)) throw new Error(`publish: ${res.error}`);
        return res.map((f) => ({ path: f.path, data: fromBase64(f.data) }));
      },
    },
    importer: {
      run: (kind, files, options) => {
        const res = parse<{ files: { path: string; data: string }[]; warnings: string[] }>(
          need(w, "import_run")(kind, JSON.stringify(files.map((f) => ({ path: f.path, data: toBase64(f.data) }))), JSON.stringify(options ?? {})),
        );
        return { files: res.files.map((f) => ({ path: f.path, data: fromBase64(f.data) })), warnings: res.warnings };
      },
    },
  };
}
