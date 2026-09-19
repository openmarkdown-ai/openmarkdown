/**
 * Stands in for the OpenSync client's `wasm/inline.ts` (1.65 MB of base64).
 *
 * OpenMarkdown serves the `.wasm` as an asset and calls `ready(url)` before
 * anything else touches the client, so the inline copy is never needed; the
 * Vite alias `./wasm/inline` points here so it is never shipped either. An
 * empty string makes a `ready()` without a URL fail loudly instead.
 */
export const WASM_BASE64 = "";
