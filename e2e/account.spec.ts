/**
 * The account: the control in the workspace, the account page, and the
 * sign-in return trip.
 *
 * Every failure here is silent in real use — a configure() that never ran, a
 * return that is never redeemed, a refactor that reintroduces the shared
 * backend's name — and none of them throws. So the account server is stubbed
 * with `page.route` (no real Google or wallet sign-in is ever driven), and the
 * assertions sit on everything either side of the identity provider. The
 * live hosts are checked at the end of this file and, after every deploy, by
 * the website repo's verify.sh.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AUTH = "https://auth.openmarkdown.ai";
const GATEWAY = "https://gateway.openmarkdown.ai";
const MARK = "▤";
const SESSION = { accessToken: "stub-access", refreshToken: "stub-refresh" };

interface Stub {
  requests: { method: string; url: string; body: string | null }[];
}

/** The account server, answered in the page: one signed-in user, any code but "good-code" refused. */
async function stubAccountServer(page: Page): Promise<Stub> {
  const stub: Stub = { requests: [] };
  await page.route(`${AUTH}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    stub.requests.push({ method: req.method(), url: req.url(), body: req.postData() });
    const cors = { "access-control-allow-origin": req.headers()["origin"] ?? "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    const user = { id: "u_stub", display_name: "Ada", referral_code: "ADA123" };
    switch (url.pathname) {
      case "/v1/auth/methods":
        return json(200, { methods: { google: true, eip155: true, nostr: true } });
      case "/v1/auth/oidc/exchange": {
        const code = JSON.parse(req.postData() ?? "{}").code;
        if (code === "good-code") return json(200, { access_token: SESSION.accessToken, refresh_token: SESSION.refreshToken, user });
        return json(400, { error: { code: "bad_request", message: "invalid or expired code" } });
      }
      case "/v1/me":
        return json(200, { ...user, balance: 1250, linked_accounts: [{ caip10: "google:1", namespace: "google", label: "ada@example.com" }] });
      case "/v1/credits/balance":
        return json(200, { balance: 1250 });
      case "/v1/credits/history":
        return json(200, { entries: [], next_cursor: null });
      case "/v1/payments/packages":
        return json(200, { packages: [{ id: "p1", credits: 1000, usd_price: 500 }], rails: { stripe: true, ethereum: false, lightning: false } });
      case "/v1/payments/topups":
        return json(200, { topups: [] });
      case "/v1/referral/code":
        return json(200, { code: "ADA123" });
      case "/v1/auth/logout":
        return json(200, { ok: true });
      case "/v1/auth/oidc/google/start":
        return route.fulfill({ status: 200, headers: { "content-type": "text/html" }, body: "<!doctype html><title>provider</title><p>stub provider</p>" });
      default:
        return json(404, { error: { code: "not_found", message: url.pathname } });
    }
  });
  return stub;
}

/** Visible text, shadow roots included: the login element's heading lives in its own shadow DOM. */
function visibleText(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [document.body.innerText];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) {
          out.push(el.shadowRoot.textContent ?? "");
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return out.join(" ");
  });
}

async function openDemoAt(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
}

// ------------------------------------------------------------------ masking

test("the backend's own domain appears only in the one module that names the hosts", () => {
  const roots = [join(here, "../apps/web/src"), join(here, "../packages/app/src"), join(here, "../apps/web/account.html"), join(here, "../apps/web/index.html")];
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p)) if (n !== "vendor" && n !== "node_modules") walk(join(p, n));
    } else if (/\.(ts|js|html|css)$/.test(p)) files.push(p);
  };
  roots.forEach(walk);
  expect(files.length).toBeGreaterThan(50);
  const offenders = files.filter((f) => !f.endsWith(join("lib", "openapps.ts")) && /openapps\.network/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
  const config = readFileSync(join(here, "../apps/web/src/lib/openapps.ts"), "utf8");
  expect(config.match(/OPENAPPS_BASE_URL\s*=\s*"([^"]+)"/)?.[1]).toBe(AUTH);
  expect(config.match(/OPENAPPS_GATEWAY_URL\s*=\s*"([^"]+)"/)?.[1]).toBe(GATEWAY);
  // The shipped build: every reference to an account host is one of ours.
  const assets = join(here, "../apps/web/dist/assets");
  for (const f of readdirSync(assets).filter((n) => n.endsWith(".js"))) {
    const text = readFileSync(join(assets, f), "utf8");
    expect(text.includes("openapps.network"), `${f} names the backend's domain`).toBe(false);
  }
});

test("no user-visible string in the app's source names the platform", () => {
  // Code may say `openapps-login` or `openapps.session`; comments may name it.
  // Anything a person can read spells the name as a name, so that is the check.
  const files = [join(here, "../apps/web/account.html"), join(here, "../apps/web/index.html"), join(here, "../apps/web/public/manifest.webmanifest"), join(here, "../apps/web/src/account/main.ts"), join(here, "../apps/web/src/account/account.css"), join(here, "../packages/app/src/chrome/account.ts"), join(here, "../packages/app/src/product.ts")];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(text.match(/OpenApps|openapps\.network/g), f).toBeNull();
  }
});

// ------------------------------------------------------------ the control

test("the account control sits top right in the workspace, and the brand mark top left links home", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.url()) && !/^(data|blob):/.test(r.url())) external.push(r.url());
  });
  await openDemoAt(page, "/app/?vault=demo");
  const control = page.getByRole("link", { name: "Account", exact: true });
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  const vw = page.viewportSize()!.width;
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThan(vw * 0.9);
  expect(box.y).toBeLessThan(40);
  expect(await control.getAttribute("href")).toBe("http://localhost:5200/app/account");
  expect(await control.getAttribute("target")).toBe("_blank");
  await expect(control).toHaveAttribute("data-signed-in", "false");

  const brand = page.getByRole("link", { name: "OpenMarkdown home" });
  await expect(brand).toBeVisible();
  expect(await brand.getAttribute("href")).toBe("/");
  const bb = (await brand.boundingBox())!;
  expect(bb.x).toBeLessThan(40);
  expect(bb.y).toBeLessThan(40);
  expect(await brand.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  // It follows the corner: open the right sidebar and split the note.
  await page.evaluate(() => (window as any).app.workspace.rightSplit.expand());
  await page.evaluate(() => (window as any).app.workspace.getLeaf("split", "vertical"));
  await page.waitForTimeout(300);
  await expect(control).toHaveCount(1);
  const moved = (await control.boundingBox())!;
  expect(moved.x).toBeGreaterThan(vw * 0.9);
  expect(moved.y).toBeLessThan(40);

  // The workspace never talks to the account server, signed in or not.
  expect(external).toEqual([]);
});

test("no footer or status bar carries an account link", async ({ page }) => {
  await openDemoAt(page, "/app/?vault=demo");
  await expect(page.locator(".status-bar a, .side-dock-settings a, footer a").filter({ hasText: /account/i })).toHaveCount(0);
  await expect(page.locator(".status-bar [aria-label='Account'], .side-dock-settings [aria-label='Account']")).toHaveCount(0);
});

test("on a phone the control is at the top right of the note's header", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await openDemoAt(page, "/app/?vault=demo");
  await expect(page.locator("body.is-phone")).toHaveCount(1);
  const control = page.getByRole("link", { name: "Account", exact: true });
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThan(390 / 2);
  expect(box.y).toBeLessThan(60);
  await context.close();
});

test("the vault chooser shows the control top right, and no brand link when served at a site's root", async ({ page }) => {
  await page.goto("/app/?choose=1");
  const control = page.getByRole("link", { name: "Account", exact: true });
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  expect(box.y).toBeLessThan(60);
  // Nothing is open on the chooser, so it takes this tab.
  expect(await control.getAttribute("target")).toBeNull();
  await expect(page.getByRole("link", { name: "OpenMarkdown home" })).toBeVisible();

  await page.goto("/?choose=1");
  await expect(page.getByRole("link", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "OpenMarkdown home" })).toHaveCount(0);
});

// --------------------------------------------------------- the account page

test("the account page reaches our own host, frames the sign-in as ours, and never names the platform", async ({ page }) => {
  const stub = await stubAccountServer(page);
  const all: string[] = [];
  page.on("request", (r) => all.push(r.url()));
  await page.goto("/app/account");
  const panel = page.getByTestId("account-panel");
  await expect(panel.locator("openapps-login")).toBeAttached();
  await expect(page.getByText("Continue with Google")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Could not reach/i)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__omAccount?.baseUrl)).toBe(AUTH);
  expect(stub.requests.some((r) => r.url === `${AUTH}/v1/auth/methods`)).toBe(true);
  expect(all.filter((u) => /openapps\.network/.test(u))).toEqual([]);

  const text = await visibleText(page);
  expect(text).not.toMatch(/openapps/i);
  expect(text).toMatch(/Sign in to OpenMarkdown/);
  const mark = await page.evaluate(() => document.querySelector("openapps-login")?.shadowRoot?.querySelector(".mark")?.textContent?.trim());
  expect(mark).toBe(MARK);
  // The glyph renders as a glyph, not a missing-character box.
  const widths = await page.evaluate((m) => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = "32px system-ui, sans-serif";
    return [c.measureText(m).width, c.measureText("￿").width];
  }, MARK);
  expect(widths[0]).not.toBe(widths[1]);

  // Signed out, the card is the whole page: no balance of 0 dressed up as real.
  await expect(page.locator("openapps-account, openapps-buy, openapps-history")).toHaveCount(0);

  // Type C workspace bar: brand to the landing page, the account control on the right.
  expect(await page.locator("#om-brand").getAttribute("href")).toBe("/");
  const control = page.locator("header .om-account-control");
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  expect(box.y).toBeLessThan(52);
  expect(await page.locator(".om-brand-tile").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const font = await page.locator("main .om-title").evaluate((h) => getComputedStyle(h).fontFamily);
  expect(font).toMatch(/Geist/);
});

test("Continue with Google leaves for our auth host and asks to come back to this page, with no fragment", async ({ page }) => {
  const stub = await stubAccountServer(page);
  await page.goto("/app/account");
  await page.getByText("Continue with Google").click();
  await page.waitForURL(`${AUTH}/v1/auth/oidc/google/start**`);
  const start = new URL(stub.requests.find((r) => r.url.includes("/oidc/google/start"))!.url);
  const returnTo = start.searchParams.get("return_to")!;
  expect(returnTo).toBe("http://localhost:5200/app/account");
  expect(returnTo).not.toContain("#");
});

test("a sign-in return is redeemed on a fresh load, shows the signed-in account, and reaches the workspace control", async ({ page }) => {
  const stub = await stubAccountServer(page);
  // A fresh load, as a real cross-origin return is: the element mounts and redeems the code.
  await page.goto("/app/account#code=good-code");
  await expect(page.locator("openapps-account")).toBeAttached({ timeout: 15_000 });
  const exchange = stub.requests.find((r) => r.url === `${AUTH}/v1/auth/oidc/exchange`);
  expect(exchange?.method).toBe("POST");
  expect(JSON.parse(exchange!.body!).code).toBe("good-code");
  // The spent code is gone from the address bar; the page stays put.
  await expect.poll(() => page.url()).toBe("http://localhost:5200/app/account");
  await expect(page.getByText("1,250").first()).toBeVisible();
  await expect(page.locator("openapps-buy")).toBeAttached();
  await expect(page.locator("openapps-history")).toBeAttached();
  const text = await visibleText(page);
  expect(text).not.toMatch(/openapps/i);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-signed-in"))).toBe(true);

  // Back to the notes: the workspace control says signed in, from local state alone.
  await page.getByRole("link", { name: "Back to your notes" }).click();
  await page.waitForURL("http://localhost:5200/app/");
  await openDemoAt(page, "/app/?vault=demo");
  await expect(page.getByRole("link", { name: "Account", exact: true })).toHaveAttribute("data-signed-in", "true");

  // Signing out on the account page, in another tab, reaches this one too.
  const second = await page.context().newPage();
  await stubAccountServer(second);
  await second.goto("/app/account");
  await second.locator("openapps-login").getByRole("button", { name: "Sign out" }).click();
  await expect(second.locator("openapps-account")).toHaveCount(0);
  await expect(second.getByText("Continue with Google")).toBeVisible();
  await expect(page.getByRole("link", { name: "Account", exact: true })).toHaveAttribute("data-signed-in", "false");
  await second.close();
});

test("a junk code is still attempted, and the page still offers sign-in", async ({ page }) => {
  const stub = await stubAccountServer(page);
  await page.goto("/app/account#code=not-a-real-code");
  await expect.poll(() => stub.requests.some((r) => r.url === `${AUTH}/v1/auth/oidc/exchange`)).toBe(true);
  await expect(page.getByText("Continue with Google")).toBeVisible();
  await expect(page.locator("openapps-account")).toHaveCount(0);
});

test("with the account server unreachable, the account page says so and the app still opens", async ({ page }) => {
  await page.route(`${AUTH}/**`, (route) => route.abort("internetdisconnected"));
  await page.goto("/app/account");
  await expect(page.getByText(/Could not reach/i).first()).toBeVisible({ timeout: 15_000 });
  await openDemoAt(page, "/app/?vault=demo");
  await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
});

// ------------------------------------------------------------ the live hosts

test.describe("the live hosts", () => {
  test.skip(!!process.env.OFFLINE, "OFFLINE=1: no network");

  test("auth. and gateway. answer over TLS, the site's origin is allowed, and /signin is a valid return", async () => {
    for (const host of [AUTH, GATEWAY]) {
      const res = await fetch(`${host}/healthz`);
      expect(res.ok, host).toBe(true);
    }
    const cors = await fetch(`${AUTH}/v1/payments/packages`, { headers: { Origin: "https://openmarkdown.ai" } });
    expect(cors.headers.get("access-control-allow-origin")).toBe("https://openmarkdown.ai");
    const rt = await fetch(`${AUTH}/v1/auth/oidc/google/start?return_to=${encodeURIComponent(`${AUTH}/signin`)}`, { redirect: "manual" });
    expect(rt.status).toBe(307);
    const back = await fetch(`${AUTH}/v1/auth/oidc/google/start?return_to=${encodeURIComponent("https://openmarkdown.ai/app/account")}`, { redirect: "manual" });
    expect(back.status).toBe(307);
    const methods = (await (await fetch(`${AUTH}/v1/auth/methods`)).json()) as { methods: Record<string, boolean> };
    expect(methods.methods.google).toBe(true);
    const signin = await (await fetch(`${AUTH}/signin`)).text();
    expect(signin.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/openapps/i);
  });
});
