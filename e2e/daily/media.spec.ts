/**
 * W6a Paste & media — external embeds, smart paste, link cards, the media
 * player with timestamp links, and downloading remote images.
 *
 *   OM_URL=http://localhost:5225 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/media.spec.ts
 *
 * No test touches the internet: every non-local request is aborted, and the
 * hosts a test needs (YouTube, Vimeo, X, example.com) are faked with
 * page.route. Playwright's fulfilled responses skip the browser's CORS check,
 * so a site that refuses cross-origin reads (docs/research/browser-native-plugins.md §2)
 * is modelled by failing the request, which is what `fetch` reports for a CORS refusal.
 */
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "openmarkdown-media-shots");
const CORS = { "access-control-allow-origin": "*" };

/** A 2×2 PNG (real bytes, decodable). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
const PNG_NAME = createHash("sha256").update(PNG).digest("hex").slice(0, 16) + ".png";
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const JPG_NAME = createHash("sha256").update(JPG).digest("hex").slice(0, 16) + ".jpg";

/** A stand-in for YouTube's embed page that speaks the IFrame API's postMessage protocol. */
const YT_STUB = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#181818;color:#ddd;font:15px system-ui">
<div id="l">YouTube player (test stub)</div><script>
window.__cmds = []; let t = Number(new URLSearchParams(location.search).get("start") || 0), rate = 1, state = 2;
function send(){ parent.postMessage(JSON.stringify({event:"infoDelivery",info:{currentTime:t,duration:600,playbackRate:rate,playerState:state}}),"*"); document.getElementById("l").textContent = "YouTube player (test stub) · " + t.toFixed(2) + "s · " + rate + "×"; }
window.__setTime = (x) => { t = x; send(); };
addEventListener("message", (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } __cmds.push(d);
  if (d.event === "command") { if (d.func === "seekTo") t = d.args[0]; if (d.func === "setPlaybackRate") rate = d.args[0]; if (d.func === "playVideo") state = 1; if (d.func === "pauseVideo") state = 2; }
  send(); });
</script></body></html>`;

const VIMEO_STUB = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1a2a33;color:#ddd;font:15px system-ui">Vimeo player (test stub)</body></html>`;

async function fakeInternet(page: Page) {
  // Registered first, so matched last: anything not faked below never leaves the machine.
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort("blockedbyclient"));
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) => route.fulfill({ contentType: "text/html", body: YT_STUB }));
  await page.route(/^https:\/\/player\.vimeo\.com\/video\//, (route) => route.fulfill({ contentType: "text/html", body: VIMEO_STUB }));
  await page.route(/^https:\/\/www\.youtube\.com\/oembed/, (route) =>
    route.fulfill({ headers: CORS, contentType: "application/json", body: JSON.stringify({ title: "Never Gonna *Give* You Up", author_name: "Rick Astley", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", provider_url: "https://www.youtube.com/" }) }),
  );
  await page.route(/^https:\/\/publish\.twitter\.com\/oembed/, (route: Route) => {
    const url = new URL(route.request().url()).searchParams.get("url") ?? "";
    if (url.includes("/status/404")) return route.fulfill({ status: 404, headers: CORS, body: "{}" });
    return route.fulfill({
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify({
        author_name: "jack",
        html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>',
      }),
    });
  });
  // example.com: pages that allow reading, a page that does not (no CORS header), images, media.
  await page.route(/^https:\/\/example\.com\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/article") {
      await new Promise((r) => setTimeout(r, 400));
      return route.fulfill({ headers: CORS, contentType: "text/html; charset=utf-8", body: "<html><head><title>An &amp; article [draft] | Example</title></head><body>hi</body></html>" });
    }
    if (path === "/og")
      return route.fulfill({
        headers: CORS,
        contentType: "text/html",
        body: '<html><head><meta property="og:title" content="Card &quot;title&quot;"><meta property="og:description" content="A short description."><link rel="icon" href="/favicon.png"><meta property="og:image" content="/cover.png"><title>ignored</title></head></html>',
      });
    if (path === "/blocked") return route.abort("failed");
    if (path === "/a.png" || path === "/same-bytes.png" || path === "/favicon.png" || path === "/cover.png") return route.fulfill({ headers: CORS, contentType: "image/png", body: PNG });
    if (path === "/octet") return route.fulfill({ headers: CORS, contentType: "application/octet-stream", body: JPG });
    if (path === "/missing.png") return route.fulfill({ status: 404, headers: CORS, body: "nope" });
    if (path === "/nocors.png") return route.abort("failed");
    if (path.endsWith(".mp4") || path.endsWith(".mp3")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 404, headers: CORS, body: "" });
  });
}

async function openVault(page: Page) {
  await fakeInternet(page);
  await page.goto("/?vault=demo");
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 30_000 });
}

async function enable(page: Page, ...ids: string[]) {
  await page.evaluate(async (ids) => {
    for (const id of ids) await (window as any).app.internalPlugins.setEnabled(id, true);
  }, ids);
}

/** Create a note and open it (Live Preview by default). */
async function openNote(page: Page, name: string, content: string, mode: "source" | "preview" = "source") {
  await page.evaluate(
    async ({ name, content, mode }) => {
      const a = (window as any).app;
      const existing = a.vault.getFileByPath(name);
      const f = existing ?? (await a.vault.create(name, content));
      if (existing) await a.vault.modify(f, content);
      const leaf = a.workspace.getLeaf(false);
      await leaf.openFile(f, { state: { mode } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
    },
    { name, content, mode },
  );
  if (mode === "source") {
    await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
  } else {
    await page.waitForSelector(".workspace-leaf.mod-active .markdown-reading-view .markdown-preview-sizer");
  }
}

/** Embeds load on click by default (nothing is sent until asked); these tests opt in to loading on render. */
async function autoLoadEmbeds(page: Page) {
  await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("external-embeds").instance.setClickToLoad(false));
}

const docText = (page: Page) => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue() as string);
const fileText = (page: Page, path: string) => page.evaluate((p) => (window as any).app.vault.adapter.read(p) as Promise<string>, path);

async function setCursor(page: Page, line: number, ch: number, toCh?: number) {
  await page.evaluate(
    ({ line, ch, toCh }) => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.focus();
      if (toCh === undefined) e.setCursor({ line, ch });
      else e.setSelection({ line, ch }, { line, ch: toCh });
    },
    { line, ch, toCh },
  );
}

/** Put text on the real clipboard and press Mod+V in the editor. */
async function paste(page: Page, context: BrowserContext, text: string) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press(`${MOD}+V`);
}

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  if (locator) await locator.screenshot({ path: join(SHOTS, name) });
  else await page.screenshot({ path: join(SHOTS, name) });
}

async function setDark(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.body.toggleClass("theme-dark", dark);
    document.body.toggleClass("theme-light", !dark);
  }, dark);
}

const EMBED_NOTE = [
  "# Embeds",
  "",
  "![](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83)",
  "",
  "![|480x270](https://youtu.be/abcDEF12345#t=1:05)",
  "",
  "![](https://www.youtube.com/shorts/sh0rtID1234)",
  "",
  "![](https://vimeo.com/123456789)",
  "",
  "![](https://x.com/jack/status/20)",
  "",
  "![](https://twitter.com/nobody/status/404)",
  "",
  "![](https://example.com/clip.mp4)",
  "",
  "![](https://example.com/song.mp3)",
  "",
  "![a picture](https://example.com/a.png)",
  "",
].join("\n");

// ============================================================================
test.describe("external embeds", () => {
  test("reading view turns YouTube, Vimeo, X and remote media links into embeds", async ({ page }) => {
    await openVault(page);
    await autoLoadEmbeds(page);
    await openNote(page, "Embeds.md", EMBED_NOTE, "preview");
    const view = page.locator(".workspace-leaf.mod-active .markdown-reading-view");
    const frames = view.locator("iframe.external-embed");
    await expect(frames).toHaveCount(4);
    expect(await frames.evaluateAll((els) => els.map((e) => e.getAttribute("src")))).toEqual([
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=83",
      "https://www.youtube-nocookie.com/embed/abcDEF12345?start=65",
      "https://www.youtube-nocookie.com/embed/sh0rtID1234",
      "https://player.vimeo.com/video/123456789?dnt=1",
    ]);
    // Size from the alt text
    await expect(view.locator(".vault-external-embed.mod-youtube").nth(1)).toHaveAttribute("width", "480");
    // Tweets: oEmbed text as a card (no script kept); a post that cannot load falls back to a link card
    const tweet = view.locator(".vault-tweet-embed").first();
    await expect(tweet.locator(".vault-tweet-body")).toContainText("just setting up my twttr");
    await expect(tweet.locator("script")).toHaveCount(0);
    const fallback = view.locator(".vault-tweet-embed.mod-fallback");
    await expect(fallback.locator("a.vault-tweet-card")).toHaveAttribute("href", "https://twitter.com/nobody/status/404");
    await expect(view.locator(".vault-external-embed.mod-video video")).toHaveAttribute("src", "https://example.com/clip.mp4");
    await expect(view.locator(".vault-external-embed.mod-audio audio")).toHaveAttribute("src", "https://example.com/song.mp3");
    await expect(view.locator("img[src='https://example.com/a.png']")).toHaveAttribute("alt", "a picture");
    await shot(page, "embeds-reading-light.png");
    await tweet.scrollIntoViewIfNeeded();
    await shot(page, "tweet-cards-light.png", view.locator(".vault-tweet-embed").first());
    await shot(page, "tweet-fallback-light.png", fallback);
    await setDark(page, true);
    await shot(page, "embeds-reading-dark.png");
  });

  test("Live Preview renders the same embeds, and the image stays an image", async ({ page }) => {
    await openVault(page);
    await autoLoadEmbeds(page);
    await openNote(page, "Embeds LP.md", EMBED_NOTE + "\ntext at the end");
    await setCursor(page, 0, 0);
    const content = page.locator(".workspace-leaf.mod-active .cm-content");
    await expect(content.locator("iframe[src='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=83']")).toHaveCount(1);
    await expect(content.locator(".vault-external-embed.mod-youtube[width='480'] iframe[src='https://www.youtube-nocookie.com/embed/abcDEF12345?start=65']")).toHaveCount(1);
    await shot(page, "embeds-live-preview-light.png");
    // CodeMirror only renders what is near the viewport: scroll to the rest.
    const scroller = page.locator(".workspace-leaf.mod-active .cm-scroller");
    const seen = async (selector: string) => {
      await expect
        .poll(async () => {
          // Heights settle as embeds load, so keep scrolling until the element is rendered.
          await scroller.evaluate((el, sel) => {
            const target = el.querySelector(sel);
            if (target) target.scrollIntoView({ block: "center" });
            else el.scrollTop += 400;
          }, selector);
          return content.locator(selector).count();
        })
        .toBeGreaterThan(0);
    };
    await seen("iframe[src^='https://player.vimeo.com/video/123456789']");
    await seen(".vault-tweet-embed .vault-tweet-body");
    await expect(content.locator(".vault-tweet-embed .vault-tweet-body").first()).toContainText("just setting up my twttr");
    await seen(".vault-external-embed.mod-video video[src='https://example.com/clip.mp4']");
    await seen("img[src='https://example.com/a.png']");
  });

  test("click to load (the default): nothing third-party loads until the placeholder is clicked", async ({ page }) => {
    await openVault(page);
    await enable(page, "media");
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await openNote(page, "Deferred.md", "![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n", "preview");
    const view = page.locator(".workspace-leaf.mod-active .markdown-reading-view");
    await expect(view.locator(".vault-embed-load-button")).toBeVisible();
    expect(requests.filter((u) => /youtube|ytimg/.test(u))).toEqual([]);
    await shot(page, "embeds-click-to-load.png", view.locator(".vault-external-embed"));
    await view.locator(".vault-embed-load-button").click();
    await expect(view.locator("iframe[src='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']")).toHaveCount(1);
  });
});

// ============================================================================
test.describe("smart paste", () => {
  test.beforeEach(async ({ page }) => {
    await openVault(page);
    await enable(page, "smart-paste");
  });

  test("a URL pasted over selected text becomes [selection](url)", async ({ page, context }) => {
    await openNote(page, "Paste 1.md", "read the docs today");
    await setCursor(page, 0, 5, 13);
    await paste(page, context, "https://example.com/docs");
    await expect.poll(() => docText(page)).toBe("read [the docs](https://example.com/docs) today");
  });

  test("a bare URL shows the Fetching Title placeholder, then the escaped page title", async ({ page, context }) => {
    await openNote(page, "Paste 2.md", "See ");
    await setCursor(page, 0, 4);
    await paste(page, context, "https://example.com/article");
    await expect.poll(() => docText(page)).toMatch(/^See \[Fetching Title#[a-z0-9]{4}\]\(https:\/\/example\.com\/article\)$/);
    await expect.poll(() => docText(page)).toBe("See [An & article \\[draft\\] \\| Example](https://example.com/article)");
  });

  test("YouTube titles come from oEmbed", async ({ page, context }) => {
    await openNote(page, "Paste 3.md", "");
    await paste(page, context, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await expect.poll(() => docText(page)).toBe("[Never Gonna \\*Give\\* You Up](https://www.youtube.com/watch?v=dQw4w9WgXcQ)");
  });

  test("a site that refuses the browser leaves the plain URL and says once how to get titles", async ({ page, context }) => {
    await openNote(page, "Paste 4.md", "");
    await paste(page, context, "https://example.com/blocked");
    await expect.poll(() => docText(page)).toBe("https://example.com/blocked");
    await expect(page.locator(".notice", { hasText: "companion extension" })).toHaveCount(1);
    await page.keyboard.press("Enter");
    await paste(page, context, "https://example.com/blocked");
    await expect.poll(() => docText(page)).toBe("https://example.com/blocked\nhttps://example.com/blocked");
    await page.waitForTimeout(300);
    await expect(page.locator(".notice", { hasText: "companion extension" })).toHaveCount(1);
  });

  test("image URLs paste as ![](url); after ]( the URL pastes as-is", async ({ page, context }) => {
    await openNote(page, "Paste 5.md", "[x](");
    await setCursor(page, 0, 4);
    await paste(page, context, "https://example.com/page");
    await expect.poll(() => docText(page)).toBe("[x](https://example.com/page");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await paste(page, context, "https://example.com/a.png");
    await expect.poll(() => docText(page)).toBe("[x](https://example.com/page\n![](https://example.com/a.png)");
  });

  test("inside code a URL pastes untouched", async ({ page, context }) => {
    await openNote(page, "Paste code.md", "```\n\n```\nsee `");
    await setCursor(page, 1, 0);
    await paste(page, context, "https://example.com/article");
    await setCursor(page, 3, 5);
    await paste(page, context, "https://example.com/a.png");
    await page.waitForTimeout(600);
    expect(await docText(page)).toBe("```\nhttps://example.com/article\n```\nsee `https://example.com/a.png");
  });

  test("hosts that never fetch get [hostname](url) with no request", async ({ page, context }) => {
    await page.evaluate(async () => {
      const inst = (window as any).app.internalPlugins.getPluginById("smart-paste").instance;
      inst.options.websiteBlacklist = "example.com";
    });
    let requested = false;
    page.on("request", (r) => (requested ||= r.url().startsWith("https://example.com/article")));
    await openNote(page, "Paste 6.md", "");
    await paste(page, context, "https://example.com/article");
    await expect.poll(() => docText(page)).toBe("[example.com](https://example.com/article)");
    expect(requested).toBe(false);
  });

  test("Paste URL as link card writes Auto Card Link's block, and cards render", async ({ page, context }) => {
    await openNote(page, "Card.md", "Intro\n");
    await setCursor(page, 1, 0);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("https://example.com/og"));
    await page.evaluate(() => (window as any).app.commands.executeCommandById("smart-paste:paste-as-card"));
    const expected = 'Intro\n\n```cardlink\nurl: https://example.com/og\ntitle: "Card \\"title\\""\ndescription: "A short description."\nhost: example.com\nfavicon: https://example.com/favicon.png\nimage: https://example.com/cover.png\n```\n';
    await expect.poll(() => docText(page)).toBe(expected);
    // Live Preview renders the block as a card once the cursor leaves it
    await setCursor(page, 0, 0);
    const lpCard = page.locator(".workspace-leaf.mod-active .cm-content .auto-card-link-card");
    await expect(lpCard).toHaveAttribute("href", "https://example.com/og");
    await expect(lpCard.locator(".auto-card-link-title")).toHaveText('Card "title"');
    await expect(lpCard.locator(".auto-card-link-host")).toHaveText("example.com");
    await shot(page, "link-card-light.png", page.locator(".workspace-leaf.mod-active .cm-content .auto-card-link-container"));
    await setDark(page, true);
    await shot(page, "link-card-dark.png", page.locator(".workspace-leaf.mod-active .cm-content .auto-card-link-container"));
  });

  test("a card that cannot be fetched restores the URL", async ({ page, context }) => {
    await openNote(page, "Card fail.md", "");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("https://example.com/blocked"));
    await page.evaluate(() => (window as any).app.commands.executeCommandById("smart-paste:paste-as-card"));
    await expect.poll(() => docText(page)).toBe("https://example.com/blocked");
  });

  test("off by default: with the plugin disabled a bare URL pastes as-is", async ({ page, context }) => {
    await page.evaluate(() => (window as any).app.internalPlugins.setEnabled("smart-paste", false));
    await openNote(page, "Paste off.md", "");
    await paste(page, context, "https://example.com/article");
    await page.waitForTimeout(600);
    expect(await docText(page)).toBe("https://example.com/article");
  });
});

// ============================================================================
test.describe("media player and timestamps", () => {
  const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  async function ytFrame(page: Page) {
    // The player pane's frame carries enablejsapi=1; a note's embed does not.
    await expect.poll(() => page.frames().some((f) => f.url().startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ") && f.url().includes("enablejsapi=1"))).toBe(true);
    const frame = page.frames().find((f) => f.url().includes("enablejsapi=1"));
    expect(frame).toBeTruthy();
    return frame!;
  }

  test("clicking a timestamp link opens the player at that time; clicking another seeks it", async ({ page }) => {
    await openVault(page);
    await enable(page, "media");
    await openNote(page, "Lecture.md", `# Lecture\n\n- [01:23](${YT}&t=83#t=01:23.47) intro\n- [10:00](${YT}&t=600#t=10:00) the middle\n`, "preview");
    await page.locator(".workspace-leaf.mod-active .markdown-reading-view a.external-link", { hasText: "01:23" }).click();
    await expect(page.locator(".workspace-leaf-content[data-type='media-player']")).toHaveCount(1);
    await expect(page.locator(".vault-media-stage iframe")).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?start=83&enablejsapi=1/);
    const frame = await ytFrame(page);
    await expect.poll(() => frame.evaluate(() => (window as any).__cmds.filter((c: any) => c.event === "listening").length)).toBeGreaterThan(0);

    // A second timestamp in the same video seeks the open player (no second pane).
    await page.locator(".markdown-reading-view a.external-link", { hasText: "10:00" }).first().click();
    await expect.poll(() => frame.evaluate(() => (window as any).__cmds.filter((c: any) => c.func === "seekTo").map((c: any) => c.args[0]))).toEqual([600]);
    await expect(page.locator(".workspace-leaf-content[data-type='media-player']")).toHaveCount(1);
    await expect(page.locator(".vault-media-time")).toHaveText("10:00 / 10:00");
  });

  test("Insert timestamp link writes Media Extended's format; speed and seek commands drive the player", async ({ page }) => {
    await openVault(page);
    await enable(page, "media");
    await openNote(page, "Notes.md", "# Notes");
    await page.evaluate((yt) => (window as any).app.internalPlugins.getPluginById("media").instance.openMedia(yt), YT);
    const frame = await ytFrame(page);
    await frame.evaluate(() => (window as any).__setTime(83.47));
    await expect(page.locator(".vault-media-time")).toHaveText("01:23 / 10:00");
    await page.evaluate(() => {
      const e = (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor;
      e.setCursor({ line: 0, ch: 7 });
    });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("media:take-timestamp"));
    await noteTextSoon(page, "Notes.md", `# Notes\n- [01:23](${YT}&t=83#t=01:23.47) `);

    await page.evaluate(() => (window as any).app.commands.executeCommandById("media:speed-up"));
    await page.evaluate(() => (window as any).app.commands.executeCommandById("media:seek-back-5"));
    await page.evaluate(() => (window as any).app.commands.executeCommandById("media:play-pause"));
    await expect
      .poll(() => frame.evaluate(() => (window as any).__cmds.filter((c: any) => c.event === "command").map((c: any) => [c.func, ...(c.args ?? [])])))
      .toEqual([["setPlaybackRate", 1.1], ["seekTo", 78.47, true], ["playVideo"]]);
    await expect(page.locator(".vault-media-rate")).toHaveText("1.1×");

    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "media-pane-light.png");
    await setDark(page, true);
    await shot(page, "media-pane-dark.png");
  });

  test("vault media: [[clip.mp4#t=…]] opens the file in the player at that time, and timestamps follow the link setting", async ({ page }) => {
    await openVault(page);
    await enable(page, "media");
    await page.evaluate(async () => {
      const a = (window as any).app;
      if (!a.vault.getFileByPath("clip.mp4")) await a.vault.createBinary("clip.mp4", new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer);
    });
    await openNote(page, "Clip notes.md", "- [[clip.mp4#t=2.00|00:02]] start\n", "preview");
    await page.locator(".workspace-leaf.mod-active .markdown-reading-view a.internal-link", { hasText: "00:02" }).click();
    const video = page.locator(".vault-media-stage video");
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(2);
    // No "clip.mp4" tab was opened by the click
    expect(await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("video").length)).toBe(0);

    await page.evaluate(async () => {
      const a = (window as any).app;
      const f = a.vault.getFileByPath("Clip notes.md");
      const leaf = a.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.path === "Clip notes.md");
      await leaf.setViewState({ type: "markdown", state: { file: f.path, mode: "source" } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
      leaf.view.editor.setCursor({ line: 0, ch: leaf.view.editor.getLine(0).length });
      a.commands.executeCommandById("media:take-timestamp");
    });
    await noteTextSoon(page, "Clip notes.md", "- [[clip.mp4#t=2.00|00:02]] start\n- [[clip.mp4#t=2.00|00:02]] \n");
  });
});

/** The note's text (from its open editor when there is one) once it equals `expected`, or the last text seen. */
async function noteTextSoon(page: Page, path: string, expected: string): Promise<string> {
  let text = "";
  await expect
    .poll(async () => {
      text = await page.evaluate(async (p) => {
        const a = (window as any).app;
        const leaf = a.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.path === p);
        return leaf?.view.editor ? leaf.view.editor.getValue() : a.vault.adapter.read(p);
      }, path);
      return text;
    })
    .toBe(expected);
  return text;
}

// ============================================================================
test.describe("local images", () => {
  test("downloads remote images into the attachment folder, de-duplicates by content, rewrites wikilinks, reports failures", async ({ page }) => {
    await openVault(page);
    await enable(page, "local-images");
    await page.evaluate(() => (window as any).app.vault.setConfig("attachmentFolderPath", "attachments"));
    const note = [
      "![](https://example.com/a.png)",
      "![logo|300](https://example.com/same-bytes.png)",
      "![](<https://example.com/octet>)",
      "![](https://example.com/missing.png)",
      "![](https://example.com/nocors.png)",
      "`![](https://example.com/a.png)` stays",
      "```",
      "![](https://example.com/a.png)",
      "```",
      "",
    ].join("\n");
    await openNote(page, "Remote.md", note);
    await page.evaluate(() => (window as any).app.commands.executeCommandById("local-images:download-current"));
    const report = page.locator(".modal.vault-local-images-report");
    await expect(report).toBeVisible();
    await expect(report.locator("tbody tr")).toHaveCount(2);
    await expect(report.locator("tbody tr").nth(0)).toContainText("https://example.com/missing.png");
    await expect(report.locator("tbody tr").nth(0)).toContainText("404");
    await expect(report.locator("tbody tr").nth(1)).toContainText("Blocked by CORS");
    await expect(report.locator("p").first()).toHaveText("Downloaded 2 images, reused 1 already in the vault, 2 failed.");
    await shot(page, "local-images-report.png", report);

    const files = await page.evaluate(() => (window as any).app.vault.getFiles().map((f: any) => f.path).filter((p: string) => p.startsWith("attachments/")).sort());
    expect(files).toEqual([`attachments/${PNG_NAME}`, `attachments/${JPG_NAME}`].sort());
    expect(await docText(page)).toBe(
      [
        `![[${PNG_NAME}]]`,
        `![[${PNG_NAME}|300]]`,
        `![[${JPG_NAME}]]`,
        "![](https://example.com/missing.png)",
        "![](https://example.com/nocors.png)",
        "`![](https://example.com/a.png)` stays",
        "```",
        "![](https://example.com/a.png)",
        "```",
        "",
      ].join("\n"),
    );
    // One undo restores every rewritten link.
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.undo());
    expect(await docText(page)).toBe(note);
    const bytes = await page.evaluate((p) => (window as any).app.vault.adapter.readBinary(p).then((b: ArrayBuffer) => b.byteLength), `attachments/${PNG_NAME}`);
    expect(bytes).toBe(PNG.length);
  });

  test("Markdown links when Use [[Wikilinks]] is off; notes that are not open are rewritten on disk; vault-wide run confirms and reuses files", async ({ page }) => {
    await openVault(page);
    await enable(page, "local-images");
    await page.evaluate(() => {
      const a = (window as any).app;
      a.vault.setConfig("attachmentFolderPath", "./assets");
      a.vault.setConfig("useMarkdownLinks", true);
    });
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.vault.createFolder("Trip").catch(() => {});
      await a.vault.create("Trip/Day 1.md", "Morning ![view](https://example.com/a.png)\n");
      await a.vault.create("Trip/Day 2.md", "Again ![](https://example.com/same-bytes.png) and ![x](https://example.com/octet)\n");
    });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("local-images:download-all"));
    const confirm = page.locator(".modal", { hasText: "Download remote images" });
    await expect(confirm).toContainText(/Download \d+ remote image links in \d+ notes\?/);
    await confirm.getByRole("button", { name: "Download" }).click();
    await expect.poll(() => fileText(page, "Trip/Day 2.md")).toBe(`Again ![${PNG_NAME}](${PNG_NAME}) and ![x](${JPG_NAME})\n`);
    expect(await fileText(page, "Trip/Day 1.md")).toBe(`Morning ![view](${PNG_NAME})\n`);
    const assets = await page.evaluate(() => (window as any).app.vault.getFiles().map((f: any) => f.path).filter((p: string) => p.includes(".png") || p.includes(".jpg")).sort());
    expect(assets).toContain(`Trip/assets/${PNG_NAME}`);
    expect(assets.filter((p: string) => p.endsWith(PNG_NAME))).toHaveLength(1);
  });

  test("Obsidian's editor:download-attachments is available without enabling the plugin", async ({ page }) => {
    await openVault(page);
    await openNote(page, "Native.md", "![](https://example.com/a.png)\n");
    const ok = await page.evaluate(() => (window as any).app.commands.executeCommandById("editor:download-attachments"));
    expect(ok).toBe(true);
    await expect.poll(() => docText(page)).toBe(`![[${PNG_NAME}]]\n`);
  });
});
