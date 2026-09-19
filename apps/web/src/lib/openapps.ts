/**
 * The account: where it talks to, and the one place those addresses live.
 *
 * OpenMarkdown is free and nothing in it is behind an account. Signing in
 * carries a balance that our other apps, where there is server-side work to
 * pay for, can spend. So there is no app key here, no charge and no
 * entitlement check; the workspace never contacts either host, and only the
 * account page (account.html) does.
 *
 * Both hostnames are the product's own names for a shared backend. A grep for
 * the backend's own domain anywhere else in the source must come back empty;
 * e2e/account.spec.ts asserts exactly that.
 *
 * The account elements (`<openapps-login>` and friends) are vendored under
 * ../vendor/openapps/, built verbatim from the suite's ui-elements package
 * (MIT OR Apache-2.0); the design tokens under ../vendor/tokens/. Refresh by
 * copying them again; never edit them in place.
 */

/** The account server, under this product's name. Sessions are bearer tokens, so nothing is domain-scoped. */
export const OPENAPPS_BASE_URL = "https://auth.openmarkdown.ai";

/**
 * The paid-feature gateway. Unused today: nothing in OpenMarkdown is charged
 * for. Named here so that the day something is, the URL already lives in the
 * one place URLs live.
 */
export const OPENAPPS_GATEWAY_URL = "https://gateway.openmarkdown.ai";

let configured: Promise<typeof import("../vendor/openapps/openapps-ui.js")> | null = null;

/**
 * Load the elements and point the shared client at our host. Idempotent.
 * Elements are created only after this resolves, so none of them ever
 * upgrades without a client.
 */
export function ensureConfigured() {
  configured ??= import("../vendor/openapps/openapps-ui.js").then((ui) => {
    ui.configure({ baseUrl: OPENAPPS_BASE_URL });
    return ui;
  });
  return configured;
}
