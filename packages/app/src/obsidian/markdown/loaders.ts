/**
 * Lazily loaded renderers: MathJax, Mermaid, Prism, PDF.js.
 *
 * Each is megabytes and most notes use none of them, so each loads on first
 * use. Plugins call the same `loadMathJax()` / `loadMermaid()` / `loadPrism()`
 * / `loadPdfJs()` the API exports and get the same instance.
 */

let mathJaxPromise: Promise<void> | null = null;

export function loadMathJax(): Promise<void> {
  mathJaxPromise ??= (async () => {
    const w = window as unknown as { MathJax?: any };
    w.MathJax = {
      startup: { typeset: false },
      tex: {
        inlineMath: [["$", "$"]],
        displayMath: [["$$", "$$"]],
        packages: { "[+]": ["noerrors", "noundefined"] },
      },
      svg: { fontCache: "global" },
      options: { enableMenu: false },
      // tex-svg-full already contains every TeX extension (noerrors and noundefined included).
      // Asking the loader for them again made it "load" components with no version
      // record and warn "No version information available for component [tex]/…" on startup.
    };
    // The combined component registers itself on window.MathJax when evaluated.
    await import("mathjax-full/es5/tex-svg-full.js" as string);
    await w.MathJax.startup?.promise;
  })();
  return mathJaxPromise;
}

function mathJax(): any | null {
  const mj = (window as unknown as { MathJax?: any }).MathJax;
  return mj && typeof mj.tex2svg === "function" ? mj : null;
}

/** Synchronous per the API: returns a placeholder that fills in if MathJax is still loading. */
export function renderMathSync(source: string, display: boolean): HTMLElement {
  const mj = mathJax();
  if (mj) return mj.tex2svg(source, { display }) as HTMLElement;
  const el = createSpan({ cls: display ? "math math-block" : "math math-inline", text: source });
  void loadMathJax().then(() => {
    const node = mathJax()?.tex2svg(source, { display }) as HTMLElement | undefined;
    if (node) el.replaceWith(node);
  });
  return el;
}

export async function renderMath(source: string, display: boolean): Promise<HTMLElement> {
  await loadMathJax();
  return renderMathSync(source, display);
}

export async function finishRenderMath(): Promise<void> {
  const mj = mathJax();
  if (!mj) return;
  const sheet = mj.svgStylesheet?.() as HTMLStyleElement | undefined;
  if (!sheet) return;
  const existing = document.getElementById("MJX-SVG-styles");
  if (existing) existing.replaceWith(sheet);
  else document.head.appendChild(sheet);
}

let mermaidPromise: Promise<any> | null = null;

export function loadMermaid(): Promise<any> {
  mermaidPromise ??= import("mermaid").then((m) => {
    const mermaid = m.default;
    const dark = document.body.hasClass("theme-dark");
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
    (window as unknown as { mermaid: unknown }).mermaid = mermaid;
    return mermaid;
  });
  return mermaidPromise;
}

let prismPromise: Promise<any> | null = null;

export function loadPrism(): Promise<any> {
  prismPromise ??= (async () => {
    const Prism = (await import("prismjs")).default;
    (window as unknown as { Prism: unknown }).Prism = Prism;
    // Components extend each other (cpp → c, tsx → jsx + typescript, php → markup-templating),
    // so load them in dependency tiers; in a production build parallel imports evaluate in
    // any order and a component that runs before its base throws. Each import settles on its
    // own so one missing language cannot take the others down.
    const tier = (loaders: (() => Promise<unknown>)[]) => Promise.allSettled(loaders.map((load) => load()));
    await tier([
      () => import("prismjs/components/prism-markup-templating"),
      () => import("prismjs/components/prism-bash"),
      () => import("prismjs/components/prism-c"),
      () => import("prismjs/components/prism-csharp"),
      () => import("prismjs/components/prism-diff"),
      () => import("prismjs/components/prism-docker"),
      () => import("prismjs/components/prism-go"),
      () => import("prismjs/components/prism-graphql"),
      () => import("prismjs/components/prism-ini"),
      () => import("prismjs/components/prism-java"),
      () => import("prismjs/components/prism-json"),
      () => import("prismjs/components/prism-kotlin"),
      () => import("prismjs/components/prism-latex"),
      () => import("prismjs/components/prism-lua"),
      () => import("prismjs/components/prism-makefile"),
      () => import("prismjs/components/prism-markdown"),
      () => import("prismjs/components/prism-perl"),
      () => import("prismjs/components/prism-python"),
      () => import("prismjs/components/prism-r"),
      () => import("prismjs/components/prism-ruby"),
      () => import("prismjs/components/prism-rust"),
      () => import("prismjs/components/prism-scss"),
      () => import("prismjs/components/prism-sql"),
      () => import("prismjs/components/prism-swift"),
      () => import("prismjs/components/prism-toml"),
      () => import("prismjs/components/prism-typescript"),
      () => import("prismjs/components/prism-yaml"),
    ]);
    await tier([
      () => import("prismjs/components/prism-cpp"),
      () => import("prismjs/components/prism-jsx"),
      () => import("prismjs/components/prism-php"),
    ]);
    await tier([() => import("prismjs/components/prism-tsx")]);
    const langs = Prism.languages as Record<string, unknown>;
    const alias = (a: string, b: string) => {
      if (!langs[a] && langs[b]) langs[a] = langs[b];
    };
    alias("js", "javascript");
    alias("ts", "typescript");
    alias("py", "python");
    alias("sh", "bash");
    alias("shell", "bash");
    alias("zsh", "bash");
    alias("yml", "yaml");
    alias("html", "markup");
    alias("xml", "markup");
    alias("svg", "markup");
    alias("md", "markdown");
    alias("rs", "rust");
    alias("cs", "csharp");
    alias("dockerfile", "docker");
    return Prism;
  })();
  return prismPromise;
}

let pdfPromise: Promise<any> | null = null;

export function loadPdfJs(): Promise<any> {
  pdfPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url" as string);
    pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    (window as unknown as { pdfjsLib: unknown }).pdfjsLib = pdfjs;
    return pdfjs;
  })();
  return pdfPromise;
}
