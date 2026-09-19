/**
 * W4 Mobile & workspace — the phone/tablet layout (Obsidian mobile's DOM),
 * touch gestures, the keyboard toolbar, and workspace restore/tab polish.
 *
 *   OM_URL=http://localhost:5223 SHOTS_DIR=/tmp/shots npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/mobile.spec.ts
 *
 * Phones and tablets are emulated in Chromium (touch, mobile viewport, device
 * user agent). Swipes and long presses are real touch events sent through
 * CDP `Input.dispatchTouchEvent`; the on-screen keyboard is simulated by
 * shrinking the viewport, which shrinks `visualViewport` as a keyboard does.
 */
import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const PHONE = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined };
const ANDROID = { ...devices["Pixel 7"], viewport: { width: 412, height: 915 }, defaultBrowserType: undefined };
const TABLET = { ...devices["iPad Pro 11"], viewport: { width: 834, height: 1194 }, defaultBrowserType: undefined };

async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR ?? test.info().outputPath();
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `mobile-${name}.png`) });
}

async function openDevice(browser: Browser, device: Record<string, unknown>, url = "/?vault=demo"): Promise<{ ctx: BrowserContext; page: Page }> {
  const { defaultBrowserType: _d, ...opts } = device as { defaultBrowserType?: unknown };
  const ctx = await browser.newContext({ ...(opts as object), baseURL: process.env.OM_URL ?? "http://localhost:5200" });
  const page = await ctx.newPage();
  await page.goto(url);
  await waitReady(page);
  return { ctx, page };
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
}

async function touch(page: Page) {
  return page.context().newCDPSession(page);
}

/** A one-finger swipe from (x1,y1) to (x2,y2). */
async function swipe(page: Page, x1: number, y1: number, x2: number, y2: number, steps = 8) {
  const cdp = await touch(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
}

async function longPress(page: Page, x: number, y: number) {
  const cdp = await touch(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(750);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(250);
}

const drawerOpen = (page: Page, side: "left" | "right") => page.locator(`.workspace-drawer.mod-${side}`).evaluate((el) => el.classList.contains("is-open"));

async function openNoteOnPhone(page: Page, name = "Welcome") {
  await page.evaluate((n) => (window as any).app.workspace.openLinkText(n, "", false), name);
  await page.waitForSelector(".mod-root .workspace-leaf.mod-active .cm-content");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(200);
}

// ============================================================================
// Phone
// ============================================================================

test.describe("phone (iPhone 13, 390×844)", () => {
  test("mobile DOM, drawers by swipe, open a note from the drawer", async ({ browser }) => {
    const { ctx, page } = await openDevice(browser, PHONE);
    const state = await page.evaluate(() => ({
      body: document.body.className,
      isMobile: (window as any).app.isMobile,
      navbar: !!document.querySelector(".app-container > .horizontal-main-container + .mobile-navbar .mobile-navbar-actions"),
      navActions: document.querySelectorAll(".mobile-navbar-action").length,
      ribbonInDrawer: !!document.querySelector(".workspace-drawer.mod-left > .workspace-drawer-ribbon"),
      dockInDrawer: !!document.querySelector(".workspace-drawer.mod-left .workspace-drawer-tab-container > .workspace-split.mod-left-split"),
      emulate: typeof (window as any).app.emulateMobile,
      navbarObj: !!(window as any).app.mobileNavbar,
      toolbarObj: !!(window as any).app.mobileToolbar,
    }));
    expect(state.body).toContain("is-mobile");
    expect(state.body).toContain("is-phone");
    expect(state.body).toContain("is-ios");
    expect(state).toMatchObject({ isMobile: true, navbar: true, navActions: 5, ribbonInDrawer: true, dockInDrawer: true, emulate: "function", navbarObj: true, toolbarObj: true });
    expect(await drawerOpen(page, "left")).toBe(false);
    await expect(page.locator(".status-bar")).toBeHidden();

    // Swipe in from the left edge: the file drawer opens over the note.
    await swipe(page, 4, 400, 220, 404);
    expect(await drawerOpen(page, "left")).toBe(true);
    await expect(page.locator(".workspace-drawer-backdrop")).toHaveClass(/is-visible/);
    const box = await page.locator(".workspace-drawer.mod-left").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.width).toBeLessThanOrEqual(390);
    await shot(page, "phone-left-drawer");

    // Tap a file: it opens and the drawer gets out of the way.
    await page.locator(".workspace-drawer.mod-left .nav-file-title", { hasText: "Formatting" }).tap();
    await page.waitForSelector(".mod-root .workspace-leaf.mod-active .view-header-title:text('Formatting')");
    await page.waitForTimeout(300);
    expect(await drawerOpen(page, "left")).toBe(false);
    // One pane: its view header spans the screen.
    const header = await page.locator(".mod-root .workspace-leaf.mod-active .view-header").boundingBox();
    expect(Math.round(header!.width)).toBe(390);
    await expect(page.locator(".mod-root .workspace-tab-header-container").first()).toBeHidden();

    // Right edge opens the right sidebar; swiping it back closes it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await swipe(page, 386, 400, 160, 404);
    expect(await drawerOpen(page, "right")).toBe(true);
    await shot(page, "phone-right-drawer");
    await swipe(page, 150, 400, 380, 404);
    expect(await drawerOpen(page, "right")).toBe(false);

    // The backdrop closes an open drawer.
    await page.locator(".vault-mobile-sidebar-toggle.mod-left").tap();
    expect(await drawerOpen(page, "left")).toBe(true);
    await page.mouse.click(370, 500);
    await page.waitForTimeout(300);
    expect(await drawerOpen(page, "left")).toBe(false);

    // Mobile layout is saved apart from the desktop one.
    await page.waitForTimeout(1500);
    const files = await page.evaluate(async () => {
      const a = (window as any).app.vault.adapter;
      return { mobile: await a.exists(".obsidian/workspace-mobile.json"), desktop: await a.exists(".obsidian/workspace.json") };
    });
    expect(files.mobile).toBe(true);
    await ctx.close();
  });

  test("type a note; the toolbar sits above a simulated keyboard and runs editor commands", async ({ browser }) => {
    const { ctx, page } = await openDevice(browser, PHONE);
    await page.evaluate(async () => {
      const a = (window as any).app;
      const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note`).join("\n");
      await a.vault.create("Phone note.md", lines + "\n");
    });
    await openNoteOnPhone(page, "Phone note");
    await expect(page.locator(".mobile-navbar")).toBeVisible();
    await expect(page.locator(".mobile-toolbar")).toBeHidden();

    await page.locator(".mod-root .workspace-leaf.mod-active .cm-line").nth(2).tap();
    await expect(page.locator(".mobile-toolbar")).toBeVisible();
    await expect(page.locator(".mobile-navbar")).toBeHidden();
    await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.setCursor({ line: 59, ch: e.getLine(59).length });
    });
    await page.keyboard.type(" hello phone");
    const text = await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getLine(59));
    expect(text).toBe("Line 60 of a long note hello phone");
    const options = await page.locator(".mobile-toolbar-option").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.commandId));
    expect(options).toContain("editor:toggle-bold");
    expect(options).toContain("editor:undo");

    // The keyboard opens: the visible area shrinks to 500px.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(500);
    const kb = await page.evaluate(() => {
      const toolbar = document.querySelector(".mobile-toolbar")!.getBoundingClientRect();
      const sel = window.getSelection()!;
      const caret = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const cursor = document.querySelector(".mod-root .workspace-leaf.mod-active .cm-cursor")?.getBoundingClientRect() ?? null;
      return {
        keyboard: document.documentElement.style.getPropertyValue("--keyboard-height"),
        toolbarTop: toolbar.top,
        toolbarBottom: toolbar.bottom,
        caretBottom: (cursor && cursor.height ? cursor : caret)?.bottom ?? -1,
        className: document.body.className,
      };
    });
    expect(kb.keyboard).toBe("344px");
    expect(kb.toolbarBottom).toBeLessThanOrEqual(500.5);
    expect(kb.toolbarBottom).toBeGreaterThan(470);
    expect(kb.caretBottom).toBeGreaterThan(0);
    expect(kb.caretBottom).toBeLessThanOrEqual(kb.toolbarTop + 1);
    expect(kb.className).toContain("is-mobile");
    await shot(page, "phone-keyboard-toolbar");

    // A toolbar button keeps focus in the editor and acts on the selection.
    await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.setSelection({ line: 59, ch: 23 }, { line: 59, ch: 28 });
    });
    const bold = page.locator('.mobile-toolbar-option[data-command-id="editor:toggle-bold"]');
    await bold.scrollIntoViewIfNeeded();
    await bold.tap();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      return { line: e.getLine(59), focus: e.hasFocus() };
    });
    expect(after.line).toBe("Line 60 of a long note **hello** phone");
    expect(after.focus).toBe(true);
    await expect(page.locator(".mobile-toolbar")).toBeVisible();

    // Keyboard closes.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-height"))).toBe("0px");
    await ctx.close();
  });

  test("pull down runs the Quick Action (command palette) as a bottom sheet", async ({ browser }) => {
    const { ctx, page } = await openDevice(browser, PHONE);
    await openNoteOnPhone(page, "Welcome");
    await swipe(page, 200, 200, 204, 330, 10);
    const prompt = page.locator(".modal-container .prompt");
    await expect(prompt).toBeVisible();
    await expect(page.locator(".prompt-input")).toHaveAttribute("placeholder", /command/i);
    await page.waitForTimeout(250);
    const box = await prompt.boundingBox();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(843);
    await shot(page, "phone-command-palette");
    await page.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
    // A sideways drag is not a pull.
    await swipe(page, 120, 300, 300, 330, 10);
    await expect(prompt).toBeHidden();
    await ctx.close();
  });

  test("tab switcher and long-press menus", async ({ browser }) => {
    const { ctx, page } = await openDevice(browser, PHONE);
    await openNoteOnPhone(page, "Welcome");
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Formatting", "", "tab"));
    await page.waitForSelector(".mod-root .workspace-leaf.mod-active .view-header-title:text('Formatting')");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(200);
    await expect(page.locator(".mobile-navbar-tabs-count")).toHaveText("2");
    await page.locator(".mobile-navbar-tabs-action").tap();
    await expect(page.locator(".mobile-tab-switcher")).toBeVisible();
    await expect(page.locator(".mobile-tab")).toHaveCount(2);
    await expect(page.locator(".mobile-tab.is-active .mobile-tab-title")).toHaveText("Formatting");
    await page.waitForTimeout(300);
    await shot(page, "phone-tab-switcher");
    await page.locator(".mobile-tab", { hasText: "Welcome" }).locator(".mobile-tab-preview").tap();
    await expect(page.locator(".mobile-tab-switcher")).toBeHidden();
    await expect(page.locator(".mod-root .workspace-leaf.mod-active .view-header-title")).toHaveText("Welcome");

    // Long press a file in the drawer: its menu opens as a bottom sheet.
    await page.locator(".vault-mobile-sidebar-toggle.mod-left").tap();
    expect(await drawerOpen(page, "left")).toBe(true);
    await page.waitForTimeout(400); // let the drawer finish sliding in
    const file = page.locator(".workspace-drawer.mod-left .nav-file-title", { hasText: "Linking notes" });
    const fb = await file.boundingBox();
    await longPress(page, fb!.x + 40, fb!.y + fb!.height / 2);
    const menu = page.locator(".menu.mod-sheet");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".menu-item-title", { hasText: /^Rename/ })).toBeVisible();
    await page.waitForTimeout(250);
    const mb = await menu.boundingBox();
    expect(Math.round(mb!.width)).toBe(390);
    expect(Math.round(mb!.y + mb!.height)).toBeGreaterThanOrEqual(843);
    await shot(page, "phone-long-press-menu");
    // The tap that dismisses the sheet does not open the note underneath.
    await page.locator(".vault-menu-backdrop").tap({ position: { x: 200, y: 60 } });
    await expect(menu).toBeHidden();
    await expect(page.locator(".mod-root .workspace-leaf.mod-active .view-header-title")).toHaveText("Welcome");
    await ctx.close();
  });

  test("settings: tab list, a page with a back button, Mobile toolbar options", async ({ browser }) => {
    const { ctx, page } = await openDevice(browser, PHONE);
    await page.locator(".mobile-navbar-action[aria-label='Open menu']").tap();
    await page.locator(".menu.mod-sheet .menu-item", { hasText: "Settings" }).tap();
    const modal = page.locator(".modal.mod-settings");
    await expect(modal).toBeVisible();
    await expect(page.locator(".vertical-tab-content-container")).toBeHidden();
    await page.waitForTimeout(250);
    await shot(page, "phone-settings-list");
    await page.locator(".vertical-tab-nav-item[data-setting-id='mobile']").tap();
    await expect(page.locator(".vertical-tab-header")).toBeHidden();
    await expect(page.locator(".modal-setting-back-button")).toBeVisible();
    const rows = page.locator(".vertical-tab-content .mobile-option-setting-item");
    expect(await rows.count()).toBeGreaterThan(10);
    // Remove the first toolbar command; the list in app.json follows.
    const before = await page.evaluate(() => (window as any).app.vault.getConfig("mobileToolbarCommands"));
    expect(before ?? null).toBeNull();
    await rows.first().locator(".clickable-icon[aria-label='Remove from toolbar']").tap();
    const afterIds = await page.evaluate(() => (window as any).app.vault.getConfig("mobileToolbarCommands"));
    expect(afterIds[0]).toBe("editor:redo");
    await page.waitForTimeout(200);
    await shot(page, "phone-settings-mobile");
    await page.locator(".modal-setting-back-button").tap();
    await expect(page.locator(".vertical-tab-header")).toBeVisible();
    // Appearance carries the layout override.
    await page.locator(".vertical-tab-nav-item[data-setting-id='appearance']").tap();
    await expect(page.locator(".setting-item", { hasText: "Mobile layout" })).toBeVisible();
    await ctx.close();
  });
});

// ============================================================================
// Android phone and tablet
// ============================================================================

test("Android phone (Pixel 7, 412×915): layout and toolbar", async ({ browser }) => {
  const { ctx, page } = await openDevice(browser, ANDROID);
  expect(await page.evaluate(() => document.body.className)).toMatch(/is-mobile.*is-phone.*is-android|is-android/);
  await openNoteOnPhone(page, "Formatting");
  await page.locator(".mod-root .workspace-leaf.mod-active .cm-line").nth(1).tap();
  await expect(page.locator(".mobile-toolbar")).toBeVisible();
  await page.setViewportSize({ width: 412, height: 560 });
  await page.waitForTimeout(400);
  const tb = await page.locator(".mobile-toolbar").boundingBox();
  expect(tb!.y + tb!.height).toBeLessThanOrEqual(560.5);
  await shot(page, "android-keyboard-toolbar");
  await ctx.close();
});

test("tablet (iPad Pro 11, 834×1194): tabs and splits kept, drawers, no navbar", async ({ browser }) => {
  const { ctx, page } = await openDevice(browser, TABLET);
  const s = await page.evaluate(() => ({ body: document.body.className, navbar: !!document.querySelector(".mobile-navbar") }));
  expect(s.body).toContain("is-mobile");
  expect(s.body).toContain("is-tablet");
  expect(s.navbar).toBe(false);
  await page.evaluate(async () => {
    const ws = (window as any).app.workspace;
    await ws.openLinkText("Welcome", "", false);
    await ws.openLinkText("Formatting", "", "split");
  });
  await page.waitForTimeout(500);
  expect(await page.locator(".mod-root .workspace-tabs.mod-visible").count()).toBe(2);
  await expect(page.locator(".mod-root .workspace-tab-header-container").first()).toBeVisible();
  await page.locator(".mod-root .sidebar-toggle-button.mod-left").tap();
  expect(await drawerOpen(page, "left")).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.locator(".workspace-drawer.mod-left .workspace-drawer-ribbon")).toBeVisible();
  await shot(page, "tablet-left-drawer");
  await ctx.close();
});

// ============================================================================
// Desktop
// ============================================================================

test.describe("desktop (1440×900)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("desktop layout unchanged; emulateMobile(true/false) switches and restores it", async ({ page }) => {
    await page.goto("/?vault=demo");
    await waitReady(page);
    const layoutBoxes = () =>
      page.evaluate(() => {
        const r = (sel: string) => {
          const b = document.querySelector(sel)!.getBoundingClientRect();
          return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
        };
        return {
          body: document.body.className,
          ribbon: r(".workspace > .workspace-ribbon.mod-left"),
          left: r(".workspace > .workspace-split.mod-left-split"),
          root: r(".workspace > .workspace-split.mod-root"),
          drawers: document.querySelectorAll(".workspace-drawer, .mobile-navbar").length,
          isMobile: (window as any).app.isMobile,
        };
      });
    const desktop = await layoutBoxes();
    expect(desktop.body).not.toContain("is-mobile");
    expect(desktop).toMatchObject({ ribbon: [0, 0, 42, 900], drawers: 0, isMobile: false });
    expect(desktop.left[2]).toBe(300);
    await shot(page, "desktop-before-emulate");

    await page.evaluate(() => (window as any).app.emulateMobile(true));
    await page.waitForTimeout(300);
    const mobile = await page.evaluate(() => ({ body: document.body.className, isMobile: (window as any).app.isMobile, drawers: document.querySelectorAll(".workspace-drawer").length }));
    expect(mobile.body).toContain("is-mobile");
    expect(mobile.isMobile).toBe(true);
    expect(mobile.drawers).toBe(2);

    await page.evaluate(() => (window as any).app.emulateMobile(false));
    await page.waitForTimeout(300);
    const back = await layoutBoxes();
    // The drawers closed the left sidebar; reopen it and the geometry is the desktop one again.
    await page.evaluate(() => (window as any).app.workspace.leftSplit.expand());
    await page.waitForTimeout(200);
    expect({ ...(await layoutBoxes()) }).toEqual(desktop);
    expect(back.drawers).toBe(0);
    await page.evaluate(() => localStorage.removeItem("vault-mobile-layout"));
  });

  test("reload restores the active tab, cursor and scroll (workspace.json eState)", async ({ page }) => {
    await page.goto("/?choose=1");
    await page.fill(".vault-starter-name", `W4 restore ${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();
    await waitReady(page);
    await page.evaluate(async () => {
      const a = (window as any).app;
      const text = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: some words to fill the note so it scrolls.`).join("\n");
      await a.vault.create("Long.md", text);
      await a.vault.create("Other.md", "other");
      await a.workspace.openLinkText("Other", "", false);
      await a.workspace.openLinkText("Long", "", "tab");
    });
    await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
    await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.setCursor({ line: 150, ch: 5 });
      e.scrollIntoView({ from: { line: 150, ch: 0 }, to: { line: 150, ch: 0 } }, true);
    });
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getScrollInfo().top);
    expect(saved).toBeGreaterThan(1000);
    await page.waitForTimeout(2500);
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(800);
    const restored = await page.evaluate(() => {
      const ws = (window as any).app.workspace;
      const e = ws.activeEditor?.editor;
      return { file: ws.getActiveFile()?.path, cursor: e?.getCursor(), top: e?.getScrollInfo().top, tabs: document.querySelectorAll(".mod-root .workspace-tab-header").length };
    });
    expect(restored.file).toBe("Long.md");
    expect(restored.tabs).toBe(2);
    expect(restored.cursor).toEqual({ line: 150, ch: 5 });
    expect(Math.abs(restored.top - saved)).toBeLessThan(60);
  });

  test("drag a tab onto the right edge of a pane: drop overlay, then a split", async ({ page }) => {
    await page.goto("/?vault=demo");
    await waitReady(page);
    await page.evaluate(async () => {
      const ws = (window as any).app.workspace;
      await ws.openLinkText("Welcome", "", false);
      await ws.openLinkText("Formatting", "", "tab");
    });
    await page.waitForTimeout(400);
    expect(await page.locator(".mod-root .workspace-tabs").count()).toBe(1);
    const tab = page.locator(".mod-root .workspace-tab-header", { hasText: "Formatting" });
    const pane = page.locator(".mod-root .workspace-tab-container").first();
    const pb = (await pane.boundingBox())!;
    const tb = (await tab.boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width - 30, pb.y + pb.height / 2, { steps: 12 });
    await page.mouse.move(pb.x + pb.width - 20, pb.y + pb.height / 2, { steps: 4 });
    const overlay = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".workspace-drop-overlay");
      return el ? { zone: el.dataset.zone, width: el.getBoundingClientRect().width } : null;
    });
    await shot(page, "desktop-tab-drop-overlay");
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(overlay?.zone).toBe("right");
    expect(await page.locator(".mod-root .workspace-tabs").count()).toBe(2);
    await expect(page.locator(".workspace-drop-overlay")).toHaveCount(0);
  });

  test("tab menu has no duplicate entries; stacked tabs put spines in the tab container", async ({ page }) => {
    await page.goto("/?vault=demo");
    await waitReady(page);
    await page.evaluate(async () => {
      const ws = (window as any).app.workspace;
      await ws.openLinkText("Welcome", "", false);
      await ws.openLinkText("Formatting", "", "tab");
      await ws.openLinkText("Linking notes", "", "tab");
    });
    await page.waitForTimeout(300);
    await page.locator(".mod-root .workspace-tab-header.is-active").click({ button: "right" });
    const titles = await page.locator(".menu .menu-item-title").allTextContents();
    const norm = titles.map((t) => t.trim().replace(/…$/, "...").toLowerCase());
    expect(new Set(norm).size).toBe(norm.length);
    expect(norm).toContain("close tabs to the right");
    await page.keyboard.press("Escape");

    await page.evaluate(() => (window as any).app.commands.executeCommandById("workspace:toggle-stacked-tabs"));
    await page.waitForTimeout(300);
    expect(await page.locator(".mod-root .workspace-tabs.mod-stacked .workspace-tab-container > .workspace-tab-header").count()).toBe(3);
    await shot(page, "desktop-stacked-tabs");
    await page.locator(".mod-root .workspace-tab-container > .workspace-tab-header", { hasText: "Welcome" }).click();
    await expect(page.locator(".mod-root .workspace-leaf.mod-active .view-header-title")).toHaveText("Welcome");
    await page.evaluate(() => (window as any).app.commands.executeCommandById("workspace:toggle-stacked-tabs"));
    await page.waitForTimeout(200);
    expect(await page.locator(".mod-root .workspace-tab-header-container-inner > .workspace-tab-header").count()).toBe(3);
  });
});
