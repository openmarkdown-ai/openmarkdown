/**
 * The account page (account.html, served at `<app>/account`).
 *
 * Signed out, the sign-in card is the whole page. Signed in: the panel's own
 * signed-in view (name, sign out), then the account with its balance, buying,
 * and history — mounted only then, because signed out each renders its own
 * "sign in to…" placeholder under a card that already asks.
 *
 * The sign-in return lands here: the login element's Google button returns
 * to this page's own URL (origin + path, no fragment), the server appends
 * `#code=…`, and the element redeems it from its connectedCallback. This is a
 * real path, not a hash route, so nothing can swallow the code first.
 */
import "../vendor/tokens/styles.css";
import "./account.css";
import { ensureConfigured } from "../lib/openapps";

/** The product's glyph for the panel: the favicon is a page of lines on a tile. */
export const ACCOUNT_MARK = "▤";

// Type C: the brand mark goes to the landing page when the app is served
// under /app/ beside it; a self-hosted copy at a site's root has no landing
// page, so it goes to the notes instead.
const brand = document.getElementById("om-brand") as HTMLAnchorElement | null;
if (brand && /\/app\/[^/]*$/.test(location.pathname)) brand.href = new URL("../", document.baseURI).pathname;

const panel = document.getElementById("account-panel")!;

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

async function main() {
  let ui: Awaited<ReturnType<typeof ensureConfigured>>;
  try {
    ui = await ensureConfigured();
  } catch (e) {
    // Offline with nothing cached, or a blocked script: say so plainly.
    console.error(e);
    panel.replaceChildren(Object.assign(document.createElement("p"), { className: "om-muted", textContent: "The account page could not load. Your notes are unaffected; check the connection and reload." }));
    return;
  }
  const client = ui.getClient();
  (window as unknown as { __omAccount?: unknown }).__omAccount = { baseUrl: client?.baseUrl };

  const login = el("openapps-login", {
    variant: "panel",
    mark: ACCOUNT_MARK,
    heading: "Sign in to OpenMarkdown",
    description: "One account across our apps. OpenMarkdown does not need it: every feature works signed out.",
  });
  const extras = el("div", { class: "om-signed-in", "data-testid": "signed-in" });
  panel.replaceChildren(login, extras);

  let shown: boolean | null = null;
  const sync = () => {
    const signedIn = ui.getClient()?.isLoggedIn ?? false;
    document.documentElement.toggleAttribute("data-signed-in", signedIn);
    if (signedIn === shown) return;
    shown = signedIn;
    extras.replaceChildren();
    if (!signedIn) return;
    // The login panel's own signed-in view carries the name and "Sign out";
    // the account card carries the balance, so neither is repeated here.
    extras.append(el("openapps-account"), el("openapps-buy"), el("openapps-history"));
  };
  sync();
  ui.onChange(sync);
  // Signing in or out in another tab of this origin.
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === "openapps.session") sync();
  });
}

void main();
