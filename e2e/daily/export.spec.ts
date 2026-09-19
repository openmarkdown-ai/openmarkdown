/**
 * W6b Export & write-ups: copy as rich text, DOCX, EPUB, PDF print path,
 * Advanced Slides decks, citations.
 *
 *   OM_URL=http://localhost:5226 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/export.spec.ts
 *
 * Screenshots go to $OM_SHOTS (default test-results/export-shots).
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const SHOTS = process.env.OM_SHOTS ?? "test-results/export-shots";
mkdirSync(SHOTS, { recursive: true });

// ---- helpers ----------------------------------------------------------------------

async function openDemo(page: Page) {
  await page.goto("/?vault=demo");
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true);
}

const NOTE = `---
title: Export sample
author: Ada Lovelace
tags: [export]
---
# Heading one

Some **bold**, *italic*, ==highlighted== and \`inline code\` text with a [link](https://example.com) and a footnote[^1].

## A table

| Name | Value |
| ---- | ----: |
| Alpha | 1 |
| Beta | 2 |

- first item
- second item
  - nested item
1. one
2. two

> [!tip] Remember
> Callouts become shaded blocks.

\`\`\`js
const answer = 42;
\`\`\`

Math: $e^{i\\pi} + 1 = 0$

![[pixel.png]]

# Second chapter

Back to [[#Heading one]].

[^1]: The footnote text.
`;

async function seedNote(page: Page, path = "Export sample.md", content = NOTE) {
  await page.evaluate(
    async ({ path, content }) => {
      const a = (window as any).app;
      if (!a.vault.getFileByPath("pixel.png")) {
        const c = document.createElement("canvas");
        c.width = 40;
        c.height = 20;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(0, 0, 40, 20);
        const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
        await a.vault.createBinary("pixel.png", await blob.arrayBuffer());
      }
      const existing = a.vault.getFileByPath(path);
      const f = existing ? (await a.vault.modify(existing, content), existing) : await a.vault.create(path, content);
      for (let i = 0; i < 100 && !a.metadataCache.getFileCache(f)?.headings; i++) await new Promise((r) => setTimeout(r, 50));
      await a.workspace.getLeaf(false).openFile(f);
    },
    { path, content },
  );
}

async function blobFrom(page: Page, script: string): Promise<Buffer> {
  const b64: string = await page.evaluate(async (script) => {
    const blob: Blob = await (0, eval)(script);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, script);
  return Buffer.from(b64, "base64");
}

interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
  localOffset: number;
  extraLength: number;
}

/** Minimal zip reader: central directory → entries (stored or deflated). */
function readZip(buf: Buffer): ZipEntry[] {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    out.push({ name, method, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw), localOffset, extraLength: lExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function setTheme(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.body.classList.toggle("theme-dark", dark);
    document.body.classList.toggle("theme-light", !dark);
  }, dark);
}

// ---- copy as rich text ---------------------------------------------------------------

test("Copy as rich text writes styled HTML with inlined images and math, plus Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openDemo(page);
  await seedNote(page);
  await page.evaluate(() => (window as any).app.commands.executeCommandById("editor:copy-as-html"));
  await expect(page.locator(".notice", { hasText: "copied as rich text" })).toBeVisible({ timeout: 20_000 });
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items[0]!;
    return {
      types: item.types,
      html: await (await item.getType("text/html")).text(),
      text: await (await item.getType("text/plain")).text(),
    };
  });
  expect(clip.types).toEqual(expect.arrayContaining(["text/html", "text/plain"]));
  expect(clip.html).toMatch(/<h1[^>]*style="[^"]*font-size/);
  expect(clip.html).toContain("<table");
  expect(clip.html).toMatch(/<td[^>]*style="[^"]*border/);
  expect(clip.html).toMatch(/<img[^>]*src="data:image\/png;base64,/);
  // Math is rasterised: at least two data-URL images (pixel + formula).
  expect((clip.html.match(/src="data:image\/png/g) ?? []).length).toBeGreaterThanOrEqual(2);
  // The formula image actually has ink (MathJax glyphs resolved from its font cache).
  const inked = await page.evaluate(async (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = [...doc.querySelectorAll("img")].filter((i) => (i.getAttribute("alt") ?? "") !== "pixel.png" && Number(i.getAttribute("height")) < 40);
    const counts: number[] = [];
    for (const i of imgs) {
      const img = new Image();
      img.src = i.getAttribute("src")!;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k]! > 128) n++;
      counts.push(n);
    }
    return counts;
  }, clip.html);
  expect(inked.length).toBeGreaterThanOrEqual(1);
  expect(Math.min(...inked)).toBeGreaterThan(50);
  expect(clip.html).toContain("Callouts become shaded blocks");
  expect(clip.html).toMatch(/border-left:4px solid rgb\(/);
  expect(clip.html).not.toContain("copy-code-button");
  expect(clip.html).not.toContain("internal-link");
  expect(clip.text).toContain("## A table");
  expect(clip.text).not.toContain("title: Export sample");
});

// ---- DOCX ---------------------------------------------------------------------------

test("Export to Word writes headings, lists, a table, footnotes, a callout and images", async ({ page }) => {
  await openDemo(page);
  await seedNote(page);
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as any).app.commands.executeCommandById("publish:export-docx"));
  const dl = await download;
  expect(dl.suggestedFilename()).toBe("Export sample.docx");
  const buf = readFileSync((await dl.path())!);
  const entries = readZip(buf);
  const names = entries.map((e) => e.name);
  expect(names).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "word/footnotes.xml", "word/numbering.xml", "word/styles.xml"]));
  const doc = entries.find((e) => e.name === "word/document.xml")!.data.toString("utf8");
  // Every XML part is well-formed.
  const xmlParts = entries.filter((e) => /\.(xml|rels)$/.test(e.name)).map((e) => e.data.toString("utf8"));
  const xmlErrors = await page.evaluate((parts) => parts.map((x) => new DOMParser().parseFromString(x, "application/xml").querySelector("parsererror")?.textContent ?? null).filter(Boolean), xmlParts);
  expect(xmlErrors).toEqual([]);
  expect(doc).toContain('<w:pStyle w:val="Title"/>');
  expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
  expect(doc).toContain('<w:pStyle w:val="Heading2"/>');
  expect(doc).toContain("<w:tbl>");
  expect(doc).toContain("Alpha");
  expect(doc).toMatch(/<w:footnoteReference w:id="1"\/>/);
  expect(doc).toMatch(/<w:numPr>/);
  expect(doc).toContain("Callouts become shaded blocks");
  expect(doc).toMatch(/<w:shd [^>]*w:fill="[0-9A-F]{6}"/);
  expect(doc).toContain('w:val="VaultCode"');
  expect(doc).toContain("const answer = 42;");
  expect(doc).toMatch(/<w:hyperlink [^>]*r:id=/);
  expect(doc).toMatch(/<w:hyperlink [^>]*w:anchor="_Ref_h1"/);
  // Word refuses duplicate bookmark and drawing ids.
  const bookmarkIds = [...doc.matchAll(/<w:bookmarkStart [^>]*w:id="(\d+)"/g)].map((m) => m[1]);
  expect(new Set(bookmarkIds).size).toBe(bookmarkIds.length);
  const docPrIds = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
  expect(new Set(docPrIds).size).toBe(docPrIds.length);
  const footnotes = entries.find((e) => e.name === "word/footnotes.xml")!.data.toString("utf8");
  expect(footnotes).toContain("The footnote text.");
  const media = names.filter((n) => n.startsWith("word/media/"));
  expect(media.length).toBeGreaterThanOrEqual(2); // pixel.png + rasterised math
});

// ---- EPUB ---------------------------------------------------------------------------

test("Export to EPUB produces a valid container: mimetype first, container.xml, OPF, nav, chapters", async ({ page }) => {
  await openDemo(page);
  await seedNote(page);
  const buf = await blobFrom(page, `(async () => { const a = window.app; return a.internalPlugins.getEnabledPluginById("export").buildBlob([a.vault.getFileByPath("Export sample.md")], "epub"); })()`);
  const entries = readZip(buf);
  // mimetype: first, stored, no extra field, exact content (OCF 3.3 §4.3).
  expect(entries[0]!.name).toBe("mimetype");
  expect(entries[0]!.method).toBe(0);
  expect(entries[0]!.extraLength).toBe(0);
  expect(entries[0]!.localOffset).toBe(0);
  expect(entries[0]!.data.toString("ascii")).toBe("application/epub+zip");
  expect(buf.subarray(30, 38).toString("ascii")).toBe("mimetype");
  const byName = new Map(entries.map((e) => [e.name, e.data.toString("utf8")]));
  const container = byName.get("META-INF/container.xml")!;
  const opfPath = /full-path="([^"]+)"/.exec(container)![1]!;
  expect(opfPath).toBe("OEBPS/content.opf");
  const opf = byName.get(opfPath)!;
  expect(opf).toMatch(/<package [^>]*version="3.0"[^>]*unique-identifier="book-id"/);
  expect(opf).toMatch(/<dc:identifier id="book-id">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/);
  expect(opf).toContain("<dc:title>Export sample</dc:title>");
  expect(opf).toContain("<dc:creator>Ada Lovelace</dc:creator>");
  expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);
  expect(opf).toMatch(/properties="nav"/);
  // Every manifest item exists; every spine itemref names a manifest item.
  const items = [...opf.matchAll(/<item id="([^"]+)" href="([^"]+)" media-type="([^"]+)"/g)];
  for (const [, , href] of items) expect(byName.has(`OEBPS/${href}`), href).toBe(true);
  const ids = new Set(items.map((m) => m[1]));
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]);
  expect(spine.length).toBe(2); // split at the two H1s
  for (const id of spine) expect(ids.has(id)).toBe(true);
  // Chapters are well-formed XHTML (parsed as XML in the browser).
  const chapters = items.filter((m) => m[3] === "application/xhtml+xml").map((m) => byName.get(`OEBPS/${m[2]}`)!);
  const errors = await page.evaluate((docs) => docs.map((d) => new DOMParser().parseFromString(d, "application/xhtml+xml").querySelector("parsererror")?.textContent ?? null), chapters);
  expect(errors).toEqual(chapters.map(() => null));
  const all = chapters.join("\n");
  expect(all).toContain("<table");
  expect(all).toContain('src="images/image-1.png"');
  expect(all).toContain("The footnote text.");
  expect(all).toMatch(/<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/); // math as inline SVG
  expect(all).toMatch(/href="chapter-001.xhtml#heading-one"/); // [[#Heading one]] from chapter 2
  expect(byName.get("OEBPS/nav.xhtml")).toContain('epub:type="toc"');
  expect(entries.some((e) => e.name.startsWith("OEBPS/images/"))).toBe(true);
  // The W3C validator, when available: EPUBCHECK=/path/to/epubcheck.jar
  if (process.env.EPUBCHECK) {
    const file = test.info().outputPath("sample.epub");
    writeFileSync(file, buf);
    const out = spawnSync("java", ["-jar", process.env.EPUBCHECK, file], { encoding: "utf8" });
    expect(out.stdout + out.stderr).toContain("No errors or warnings detected");
  }
});

// ---- PDF ----------------------------------------------------------------------------

test("Export to PDF: options modal, @page CSS with margin boxes, TOC, and page numbers in the printed PDF", async ({ page }) => {
  await openDemo(page);
  await seedNote(page);
  await page.evaluate(() => {
    (window as any).__printed = null;
    window.print = () => {
      (window as any).__printed = {
        css: document.getElementById("vault-print-style")?.textContent ?? "",
        html: document.querySelector("body > .print")?.innerHTML ?? "",
        bodyClass: document.body.className,
        title: document.title,
      };
    };
  });
  await page.evaluate(() => (window as any).app.commands.executeCommandById("workspace:export-pdf"));
  const modal = page.locator(".modal.mod-pdf-export");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".setting-item-name", { hasText: "Page numbers" })).toBeVisible(); // Chromium: margin boxes supported
  await modal.locator(".setting-item", { hasText: "Table of contents" }).locator(".checkbox-container").click();
  await modal.locator(".setting-item", { hasText: "Page size" }).locator("select").selectOption("Letter");
  await modal.locator(".setting-item", { hasText: "Header" }).locator("input").fill("{{title}} | | {{date}}");
  await page.waitForTimeout(400); // toggle transition
  await page.screenshot({ path: join(SHOTS, "pdf-modal-light.png") });
  await setTheme(page, true);
  await page.screenshot({ path: join(SHOTS, "pdf-modal-dark.png") });
  await setTheme(page, false);
  await modal.locator("button.mod-cta").click();
  await page.waitForFunction(() => (window as any).__printed, null, { timeout: 30_000 });
  const printed = await page.evaluate(() => (window as any).__printed);
  expect(printed.css).toContain("size: Letter portrait;");
  expect(printed.css).toMatch(/margin: 18mm 16mm 18mm 16mm;/);
  expect(printed.css).toMatch(/@top-left \{ content: "Export sample";/);
  expect(printed.css).toMatch(/@top-right \{ content: "\d{4}-\d\d-\d\d";/);
  expect(printed.css).toMatch(/@bottom-center \{ content: counter\(page\) " \/ " counter\(pages\);/);
  expect(printed.bodyClass).toContain("is-printing");
  expect(printed.title).toBe("Export sample");
  expect(printed.html).toContain('class="vault-export-toc"');
  expect(printed.html).toMatch(/<a href="#heading-one">Heading one<\/a>/);
  expect(printed.html).toMatch(/<a href="#a-table">A table<\/a>/);
  expect(printed.html).toMatch(/<h1[^>]*class="inline-title vault-export-title"[^>]*>Export sample<\/h1>/);

  // The print container is still in place (afterprint has not fired): print it for real.
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    texts.push(content.items.map((it: any) => it.str).join(" "));
  }
  const firstPage = await doc.getPage(1);
  const [, , w, h] = firstPage.view;
  expect(Math.round(w)).toBe(612); // US Letter, 8.5in × 72
  expect(Math.round(h)).toBe(792);
  expect(doc.numPages).toBeGreaterThanOrEqual(2); // TOC page breaks before the note
  expect(texts[0]).toContain("Contents");
  expect(texts[0]).toMatch(new RegExp(`1\\s*/\\s*${doc.numPages}`)); // footer: page / pages
  expect(texts[1]).toMatch(new RegExp(`2\\s*/\\s*${doc.numPages}`));
  expect(texts[1]).toContain("Export sample"); // header title
  expect(texts.join(" ")).toContain("Callouts become shaded blocks");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator("body > .print")).toHaveCount(0);
  await expect(page.locator("#vault-print-style")).toHaveCount(0);
});

test("Export folder to PDF puts each note on its own page, Better Export PDF templates honoured", async ({ page }) => {
  await openDemo(page);
  const printed = await page.evaluate(async () => {
    const a = (window as any).app;
    window.print = () => {
      (window as any).__printed = { css: document.getElementById("vault-print-style")?.textContent ?? "", notes: document.querySelectorAll("body > .print .vault-pdf-note").length };
    };
    const files = a.vault.getFileByPath("Books/The Overstory.md").parent.children.filter((f: any) => f.extension === "md");
    await a.internalPlugins.getEnabledPluginById("export-pdf").exportPdf(files, { toc: false });
    const multi = (window as any).__printed;
    window.dispatchEvent(new Event("afterprint"));
    const f = await a.vault.create("BEP.md", '---\nheaderTemplate: \'<div style="width:100%"><span class="title"></span></div>\'\nfooterTemplate: \'<div><span class="pageNumber"></span> of <span class="totalPages"></span></div>\'\n---\nBody');
    for (let i = 0; i < 60 && !a.metadataCache.getFileCache(f)?.frontmatter; i++) await new Promise((r) => setTimeout(r, 50));
    await a.internalPlugins.getEnabledPluginById("export-pdf").exportPdf([f], { pageNumbers: true });
    const single = (window as any).__printed;
    window.dispatchEvent(new Event("afterprint"));
    return { multi, single, count: files.length };
  });
  expect(printed.multi.notes).toBe(printed.count);
  expect(printed.multi.css).toContain(".vault-pdf-note + .vault-pdf-note { break-before: page; }");
  expect(printed.single.css).toMatch(/@top-center \{ content: "BEP";/);
  expect(printed.single.css).toMatch(/@bottom-center \{ content: counter\(page\) " of " counter\(pages\);/);
});

// ---- Slides (Advanced Slides syntax, reveal.js) --------------------------------------

const DECK = `---
theme: night
transition: fade
---
<!-- slide bg="#223344" -->
# Welcome

Intro paragraph <!-- element class="fragment" -->

note: Say hello first.

---

## Vertical A

+ one
+ two

--

## Vertical B

Some text

Note: Second vertical notes

---

## Code keeps its rules

\`\`\`md
---
--
\`\`\`

$$E = mc^2$$
`;

test("Slides: Advanced Slides decks parse, present with reveal.js, open a speaker view and export to HTML", async ({ page, context }) => {
  await openDemo(page);
  await page.evaluate(() => (window as any).app.internalPlugins.setEnabled("slides", true));
  await seedNote(page, "Deck.md", DECK);
  const parsed = await page.evaluate((text) => {
    const deck = (window as any).app.internalPlugins.getEnabledPluginById("slides").parseDeck(text);
    return { stacks: deck.stacks.map((s: any[]) => s.length), notes: deck.stacks.flat().map((s: any) => s.notes), attrs: deck.stacks[0][0].attrs, options: deck.options, fragments: deck.stacks[1][0].fragmentLines };
  }, DECK);
  expect(parsed.stacks).toEqual([1, 2, 1]);
  expect(parsed.notes).toEqual(["Say hello first.", "", "Second vertical notes", ""]);
  expect(parsed.attrs).toEqual({ bg: "#223344" });
  expect(parsed.options).toEqual({ transition: "fade" });
  expect(parsed.fragments).toEqual([2, 3]);

  await page.evaluate(() => (window as any).app.commands.executeCommandById("slides:start"));
  const container = page.locator(".vault-reveal-container");
  await expect(container.locator(".reveal.ready")).toBeVisible({ timeout: 30_000 });
  await expect(container.locator(".slides > section")).toHaveCount(3);
  await expect(container.locator(".slides > section > section")).toHaveCount(2);
  await expect(container.locator(".slides > section").first()).toHaveAttribute("data-background-color", "#223344");
  await expect(container.locator(".slides > section").first().locator("p.fragment", { hasText: "Intro paragraph" })).toHaveCount(1);
  await expect(container.locator("li.fragment")).toHaveCount(2);
  await expect(container.locator("aside.notes")).toHaveCount(2);
  await expect(page.locator("style[data-vault-reveal]")).toHaveCount(2); // reveal.css + night theme (no remote @import)
  expect(await page.evaluate(() => [...document.querySelectorAll("style[data-vault-reveal]")].some((s) => s.textContent!.includes("@import")))).toBe(false);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, "slides-title.png") });
  await page.keyboard.press("ArrowRight"); // fragment
  await page.keyboard.press("ArrowRight"); // Vertical A
  await expect.poll(() => page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("slides").getReveal()?.deck.getIndices())).toEqual({ h: 1, v: 0, f: -1 });
  await page.keyboard.press("ArrowRight"); // + one
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, "slides-fragments.png") });
  await page.keyboard.press("Escape");
  await expect(container).toHaveCount(0);
  await expect(page.locator("style[data-vault-reveal]")).toHaveCount(0);

  // Speaker view in a popup window.
  const popupPromise = page.waitForEvent("popup");
  await page.evaluate(() => (window as any).app.commands.executeCommandById("slides:speaker-view"));
  const popup = await popupPromise;
  await expect(popup.locator(".vault-speaker-notes")).toContainText("Say hello first.", { timeout: 30_000 });
  await expect(popup.locator(".vault-speaker-counter")).toHaveText("Slide 1 of 4");
  await expect(popup.locator(".vault-speaker-next h2")).toHaveText("Vertical A");
  await popup.setViewportSize({ width: 1100, height: 720 });
  // fragment, → Vertical A, + one, + two, ↓ Vertical B
  for (let i = 0; i < 5; i++) await popup.locator("button", { hasText: "Next" }).click();
  await expect(popup.locator(".vault-speaker-counter")).toHaveText("Slide 3 of 4");
  await expect(popup.locator(".vault-speaker-notes")).toContainText("Second vertical notes");
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: join(SHOTS, "slides-speaker-view.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator(".vault-reveal-container")).toHaveCount(0);
  await expect.poll(() => popup.isClosed()).toBe(true);

  // Self-contained HTML export runs on its own.
  const html: string = await page.evaluate(() => {
    const a = (window as any).app;
    return a.internalPlugins.getEnabledPluginById("slides").exportHtml(a.vault.getFileByPath("Deck.md"));
  });
  expect(html).toContain("window.Reveal.initialize(");
  expect(html).not.toMatch(/export\s*\{\s*\w+ as default\s*\}/);
  expect(html).not.toContain("@import");
  expect(html).not.toMatch(/(src|href)="https?:\/\//);
  expect(html).toContain('<aside class="notes">');
  expect(html).toMatch(/<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  const standalone = await context.newPage();
  await standalone.route("**/*", (route) => (route.request().url().startsWith("http://deck.test/") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort()));
  await standalone.goto("http://deck.test/deck.html");
  await expect(standalone.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
  expect(await standalone.evaluate(() => (window as any).Reveal.getTotalSlides())).toBe(4);
  await standalone.close();

  // Plain notes keep the built-in slides.
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Welcome.md"));
    await a.commands.executeCommandById("slides:start");
  });
  await expect(page.locator(".slides-container .reveal .slides > section").first()).toBeAttached();
  await expect(page.locator(".vault-reveal-container")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

// ---- Citations ----------------------------------------------------------------------------

const BIB = String.raw`@string{jex = {Journal of Examples}}
@article{smith2020,
  author = {Smith, Jane and Jones, Robert},
  title = {A Study of {Things}},
  journal = jex,
  year = {2020},
  volume = {12},
  number = {3},
  pages = {45--67},
  doi = {10.1000/xyz123},
  abstract = {We study things carefully.}
}
@book{doe2019,
  author = {John Doe},
  title = {The Book of M{\"u}ller},
  publisher = {Example Press},
  address = {New York},
  year = 2019
}
`;

async function setupCitations(page: Page) {
  await page.evaluate(async (bib) => {
    const a = (window as any).app;
    await a.vault.create("refs.bib", bib);
    await a.internalPlugins.setEnabled("citations", true);
    const c = a.internalPlugins.getEnabledPluginById("citations");
    c.options.citationExportPath = "refs.bib";
    await c.reload();
  }, BIB);
}

test("Citations: [@ autocomplete, formatted citations, bibliography, hover preview, export, step aside", async ({ page }) => {
  await openDemo(page);
  await setupCitations(page);
  const entries = await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("citations").getEntries().map((e: any) => [e.citekey, e.authorString, e.year, e.title]));
  expect(entries).toEqual([
    ["smith2020", "Jane Smith, Robert Jones", "2020", "A Study of Things"],
    ["doe2019", "John Doe", "2019", "The Book of Müller"],
  ]);

  await seedNote(page, "Paper.md", "# Paper\n\nIntro.\n");
  await page.locator(".workspace-leaf.mod-active .cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("As shown [@smi");
  const suggestion = page.locator(".suggestion-container .suggestion-item.vault-citation-suggestion");
  await expect(suggestion.first()).toContainText("@smith2020");
  await expect(suggestion.first()).toContainText("A Study of Things");
  await page.screenshot({ path: join(SHOTS, "citations-autocomplete-light.png") });
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and @doe2019 argues.");
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue())).toContain("As shown [@smith2020] and @doe2019 argues.");

  // Insert bibliography (Markdown, APA).
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.evaluate(() => (window as any).app.commands.executeCommandById("citations:insert-bibliography"));
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue())).toContain("Smith, J., & Jones, R. (2020). A Study of Things. *Journal of Examples*, *12*(3), 45–67.");
  const md: string = await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue());
  expect(md).toContain("## References");
  expect(md).toContain("Doe, J. (2019). *The Book of Müller*. Example Press.");
  // Remove the inserted Markdown bibliography so reading view shows the generated one only.
  await page.evaluate(async () => {
    const a = (window as any).app;
    const ed = a.workspace.activeEditor.editor;
    ed.setValue(ed.getValue().split("## References")[0]);
    await a.workspace.activeEditor.save?.();
  });

  // Reading view: formatted citations and a bibliography.
  await page.evaluate(async () => {
    const leaf = (window as any).app.workspace.activeLeaf;
    await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "preview" } });
  });
  const reading = page.locator(".workspace-leaf.mod-active .markdown-reading-view");
  await expect(reading.locator(".vault-citation").first()).toHaveText("(Smith & Jones, 2020)", { timeout: 20_000 });
  await expect(reading.locator(".vault-citation").nth(1)).toHaveText("Doe (2019)");
  await expect(reading.locator(".vault-bibliography .csl-entry")).toHaveCount(2);
  await expect(reading.locator(".vault-bibliography")).toContainText("The Book of Müller");
  await reading.locator(".vault-citation").first().hover();
  const pop = page.locator("body > .vault-citation-popover");
  await expect(pop).toContainText("Journal of Examples");
  await expect(pop).toContainText("We study things carefully.");
  await page.screenshot({ path: join(SHOTS, "citations-popover-light.png") });
  await setTheme(page, true);
  await reading.locator("h1").first().hover();
  await reading.locator(".vault-citation").first().hover();
  await expect(pop).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "citations-popover-dark.png") });
  await setTheme(page, false);

  // Editor: hovering a citekey shows the same reference.
  await page.evaluate(async () => {
    const leaf = (window as any).app.workspace.activeLeaf;
    await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "source" } });
  });
  const point = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".workspace-leaf.mod-active .cm-content")!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      const i = t.data.indexOf("smith2020");
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(t, i + 2);
        r.setEnd(t, i + 3);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x - 40, point!.y + 40);
  await page.mouse.move(point!.x, point!.y, { steps: 4 });
  await expect(page.locator(".cm-tooltip .vault-citation-popover")).toContainText("Journal of Examples", { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, "citations-editor-hover-light.png") });
  await page.mouse.move(5, 5);

  // Exports carry the formatted citations and the bibliography.
  const payload = await page.evaluate(() => {
    const a = (window as any).app;
    return a.internalPlugins.getEnabledPluginById("export").richCopyPayload(a.vault.getFileByPath("Paper.md"));
  });
  expect(payload.html).toContain("(Smith &amp; Jones, 2020)");
  expect(payload.html).toContain("References");
  expect(payload.html).toContain("Journal of Examples");

  // Steps aside while the Citations community plugin is enabled.
  const aside = await page.evaluate(() => {
    const a = (window as any).app;
    a.plugins.enabledPlugins.add("obsidian-citation-plugin");
    const off = a.commands.executeCommandById("citations:open-literature-note");
    a.plugins.enabledPlugins.delete("obsidian-citation-plugin");
    const on = a.commands.executeCommandById("citations:open-literature-note");
    document.querySelector(".modal-container .modal-close-button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { off, on };
  });
  expect(aside).toEqual({ off: false, on: true });
});

test("Citations: BibTeX parsing handles names, accents, macros and dates", async ({ page }) => {
  await openDemo(page);
  await setupCitations(page);
  const parsed = await page.evaluate(async () => {
    const a = (window as any).app;
    const src = String.raw`@inproceedings{van2021, author = {van der Berg, Anna and {World Health Organization} and Ludwig van Beethoven}, title = "On {\'E}l{\`e}ve -- a {\v{C}}ech {\ss}tudy", booktitle = {Proc. } # {Conf}, date = {2021-05-03}, urldate = {2022-01-02}}`;
    await a.vault.create("more.bib", src);
    const c = a.internalPlugins.getEnabledPluginById("citations");
    c.options.citationExportPath = "more.bib";
    await c.reload();
    return c.getEntries()[0].csl;
  });
  expect(parsed.type).toBe("paper-conference");
  expect(parsed.author).toEqual([{ family: "Berg", given: "Anna", "non-dropping-particle": "van der" }, { literal: "World Health Organization" }, { given: "Ludwig", "non-dropping-particle": "van", family: "Beethoven" }]);
  expect(parsed.title).toBe("On Élève – a Čech ßtudy");
  expect(parsed["container-title"]).toBe("Proc. Conf");
  expect(parsed.issued).toEqual({ "date-parts": [[2021, 5, 3]] });
  expect(parsed.accessed).toEqual({ "date-parts": [[2022, 1, 2]] });
});

// ---- Pandoc (optional, consent first) --------------------------------------------------

test("Export with pandoc asks before downloading, then converts to LaTeX in a worker", async ({ page }) => {
  test.setTimeout(240_000);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("pandoc.wasm")) requests.push(r.url());
  });
  const local = process.env.PANDOC_WASM; // path to pandoc.wasm (pandoc.org/app/pandoc.wasm); the conversion half is skipped without it
  if (local) {
    await page.route("https://pandoc.org/app/pandoc.wasm", (route) => route.fulfill({ status: 200, headers: { "content-type": "application/wasm", "access-control-allow-origin": "*" }, body: readFileSync(local) }));
  }
  await openDemo(page);
  await seedNote(page);
  await page.evaluate(() => caches.delete("vault-pandoc-v1"));
  await page.evaluate(() => (window as any).app.commands.executeCommandById("publish:export-pandoc"));
  const modal = page.locator(".modal.mod-pandoc-export");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("about 59 MB");
  await expect(modal).toContainText("GNU GPL");
  await expect(modal.locator("button.mod-cta")).toHaveText("Download pandoc (59 MB) and export");
  await page.waitForTimeout(400); // modal fade-in
  await page.screenshot({ path: join(SHOTS, "pandoc-consent-light.png") });
  await setTheme(page, true);
  await page.screenshot({ path: join(SHOTS, "pandoc-consent-dark.png") });
  await setTheme(page, false);
  expect(requests).toEqual([]); // nothing fetched before consent
  if (!local || !existsSync(local)) {
    await modal.locator("button", { hasText: "Cancel" }).click();
    return;
  }
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await modal.locator("button.mod-cta").click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe("Export sample.tex");
  const tex = readFileSync((await dl.path())!, "utf8");
  expect(tex).toContain("\\documentclass");
  expect(tex).toContain("\\section{Heading one}");
  expect(tex).toContain("\\footnote{The footnote text.}");
  expect(tex).toMatch(/\\begin\{longtable\}/);
  expect(requests.length).toBe(1);
  // Cached: the second export does not download again.
  await page.evaluate(() => (window as any).app.commands.executeCommandById("publish:export-pandoc"));
  await expect(page.locator(".modal.mod-pandoc-export button.mod-cta")).toHaveText("Export");
});

test("Citations: Zotero web API (key from the keychain) and CSL-JSON / Better BibTeX JSON files", async ({ page }) => {
  await openDemo(page);
  const seen: { url: string; key: string | undefined }[] = [];
  await page.route("https://api.zotero.org/**", (route) => {
    seen.push({ url: route.request().url(), key: route.request().headers()["zotero-api-key"] });
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "Total-Results", "Total-Results": "2" },
      body: JSON.stringify([
        { key: "ABCD1234", data: { itemType: "journalArticle", citationKey: "lovelace1843" }, csljson: { id: "x", type: "article-journal", title: "Notes on the Analytical Engine", author: [{ family: "Lovelace", given: "Ada" }], issued: { "date-parts": [[1843]] } } },
        { key: "EFGH5678", data: { itemType: "book", extra: "" }, csljson: { id: "y", type: "book", title: "Computable Numbers", author: [{ family: "Turing", given: "Alan" }], issued: { "date-parts": [[1936]] } } },
      ]),
    });
  });
  const result = await page.evaluate(async () => {
    const a = (window as any).app;
    a.secretStorage.setSecret("zotero-key", "s3cret");
    await a.vault.create("lib.json", JSON.stringify({ items: [{ itemType: "book", citationKey: "knuth1984", title: "Literate Programming", creators: [{ creatorType: "author", firstName: "Donald", lastName: "Knuth" }], date: "1984-05" }] }));
    await a.internalPlugins.setEnabled("citations", true);
    const c = a.internalPlugins.getEnabledPluginById("citations");
    Object.assign(c.options, { citationExportPath: "lib.json", zoteroUserId: "42", zoteroApiKeySecret: "zotero-key" });
    await c.reload();
    const entries = c.getEntries().map((e: any) => [e.citekey, e.source, e.year]);
    const f = await a.vault.create("Lit.md", "x");
    const cited = await c.formatCitation("See [@lovelace1843, p. 7; @turing1936].");
    return { entries, cited, created: !!f };
  });
  expect(seen[0]!.url).toContain("/users/42/items?");
  expect(seen[0]!.key).toBe("s3cret");
  expect(result.entries).toEqual([
    ["knuth1984", "file", "1984"],
    ["lovelace1843", "zotero", "1843"],
    ["turing1936", "zotero", "1936"],
  ]);
  expect(result.cited).toEqual(["(Lovelace, 1843, p. 7; Turing, 1936)"]);
  // Literature note from the Citations template.
  await page.evaluate(async () => {
    const a = (window as any).app;
    const c = a.internalPlugins.getEnabledPluginById("citations");
    const plugin = a.internalPlugins.getPluginById("citations").instance.plugin;
    await plugin.openLiteratureNote(c.getEntries().find((e: any) => e.citekey === "knuth1984"));
  });
  const note = await page.evaluate(() => (window as any).app.vault.adapter.read("Reading notes/@knuth1984.md"));
  expect(note).toBe("---\ntitle: Literate Programming\nauthors: Donald Knuth\nyear: 1984\n---\n\n");
});
