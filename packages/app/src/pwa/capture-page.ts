/**
 * The capture page: `/?capture=1` and the share target's `/?share=…`.
 *
 * It exists for latency. It shows the capture sheet as soon as the vault's
 * storage handle is available — before the wasm engine, plugins, layout or
 * index — and writes straight through the storage adapter. Opening the vault
 * afterwards indexes the new text like any other change.
 *
 * Parameters: `vault` (id or name; default the last opened), `text`,
 * `dest` (`daily` | `inbox` | `new`), `save=1` (write `text` at once, for
 * automation such as an iOS Shortcut).
 */
import type { VaultRecord } from "../boot";
import { adapterIO, capture, loadCaptureOptions, type CaptureDestination, type QuickCaptureOptions, DEFAULT_CAPTURE_OPTIONS } from "../core-plugins/quick-capture/capture";
import { renderCaptureSurface } from "../core-plugins/quick-capture/surface";
import { setIcon } from "../obsidian/ui/icons";
import { moment } from "../obsidian/util";
import type { VaultAdapter } from "../obsidian/vault/adapter";
import { PRODUCT_NAME } from "../product";
import { maybeShowSafariStorageBanner } from "./install";
import { setPendingOpen } from "./launch";
import { forgetShare, shareToText, type IncomingShare } from "./share";
import { registerUnsavedCheck } from "./sw-client";

export interface CapturePageContext {
  root: HTMLElement;
  params: URLSearchParams;
  vaults: VaultRecord[];
  share: IncomingShare | null;
  adapterFor(v: VaultRecord, requestPermission: boolean): Promise<VaultAdapter | "needs-permission">;
  demoAdapter(): VaultAdapter;
}

function pickVault(vaults: VaultRecord[], wanted: string | null): VaultRecord | "demo" | null {
  if (wanted === "demo") return "demo";
  if (wanted) {
    const lower = wanted.toLowerCase();
    return vaults.find((v) => v.id === wanted) ?? vaults.find((v) => v.name.toLowerCase() === lower) ?? null;
  }
  return vaults[0] ?? null;
}

function configDirFor(vaultId: string): string {
  try {
    const raw = localStorage.getItem(`${vaultId}-config-dir`);
    const v = raw ? JSON.parse(raw) : null;
    return typeof v === "string" && v.startsWith(".") ? v : ".obsidian";
  } catch {
    return ".obsidian";
  }
}

function appUrl(params: Record<string, string>): string {
  const url = new URL("./", location.href);
  url.search = "";
  url.hash = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Light or dark as the vault's Appearance setting says (`theme`: "moonstone" light, "obsidian" dark, "system"). */
async function applyVaultTheme(adapter: VaultAdapter | null, configDir: string) {
  let theme = "system";
  try {
    if (adapter && (await adapter.exists(`${configDir}/appearance.json`))) theme = String(JSON.parse(await adapter.read(`${configDir}/appearance.json`)).theme ?? "system");
  } catch {
    /* default */
  }
  const dark = theme === "obsidian" || (theme !== "moonstone" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.toggleClass("theme-dark", dark);
  document.body.toggleClass("theme-light", !dark);
}

export async function showCapturePage(ctx: CapturePageContext): Promise<void> {
  const { root, params } = ctx;
  root.empty();
  document.body.addClass("vault-capture-route");
  const page = root.createDiv({ cls: "vault-capture-page" });
  const wanted = params.get("vault");
  const target = pickVault(ctx.vaults, wanted);

  if (!target) {
    const empty = page.createDiv({ cls: "vault-capture-empty" });
    setIcon(empty.createDiv({ cls: "vault-capture-empty-icon" }), "lucide-folder-x");
    empty.createDiv({ cls: "vault-capture-title", text: wanted ? `No vault named “${wanted}” in this browser` : "No vault yet" });
    empty.createDiv({ cls: "vault-capture-detail", text: `Open or create a vault in ${PRODUCT_NAME} first; captures go into it.` });
    const btn = empty.createEl("button", { cls: "mod-cta", text: "Choose a vault" });
    btn.addEventListener("click", () => (location.href = appUrl({ choose: "1" })));
    return;
  }

  const vaultId = target === "demo" ? "demo" : target.id;
  const vaultName = target === "demo" ? "Demo vault" : target.name;
  const configDir = target === "demo" ? ".obsidian" : configDirFor(target.id);
  let adapter: VaultAdapter | null = null;
  if (target === "demo") adapter = ctx.demoAdapter();
  else {
    const a = await ctx.adapterFor(target, false).catch(() => "needs-permission" as const);
    adapter = a === "needs-permission" ? null : a;
  }
  let options: QuickCaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS };
  if (adapter) options = await loadCaptureOptions(adapterIO(adapter), configDir).catch(() => options);
  await applyVaultTheme(adapter, configDir);

  const getAdapter = async (): Promise<VaultAdapter> => {
    if (adapter) return adapter;
    if (target === "demo") return (adapter = ctx.demoAdapter());
    // Folder vaults re-ask for access; this runs inside the Save click, which counts as a gesture.
    const a = await ctx.adapterFor(target, true);
    if (a === "needs-permission") throw new Error(`${PRODUCT_NAME} needs access to the “${vaultName}” folder to save.`);
    adapter = a;
    options = await loadCaptureOptions(adapterIO(a), configDir).catch(() => options);
    return a;
  };

  const share = ctx.share;
  const shareText = share ? shareToText(share) : "";
  // A GET share carries its text in `text` too; use it once.
  const initialText = share ? shareText : (params.get("text") ?? "");
  const attachments = share?.files ?? [];
  const destParam = params.get("dest") as CaptureDestination | null;
  const destination: CaptureDestination = destParam === "daily" || destParam === "inbox" || destParam === "new" ? destParam : options.destination;

  const doSave = async (text: string, dest: CaptureDestination) => {
    const a = await getAdapter();
    const files = await Promise.all(attachments.map(async (f) => ({ name: f.name, data: await f.blob.arrayBuffer() })));
    const result = await capture({ io: adapterIO(a), configDir, options }, { text, destination: dest, attachments: files, now: moment() });
    attachments.length = 0;
    if (share) await forgetShare(share);
    return result;
  };

  const surface = renderCaptureSurface({
    parent: page,
    mode: "page",
    vaultName,
    initialText,
    attachments: attachments.map((f) => ({ name: f.name, size: f.blob.size })),
    destination,
    inboxPath: options.inboxPath,
    save: doSave,
    openNote: (path) => {
      if (vaultId !== "demo") setPendingOpen(vaultId, [path]);
      location.href = appUrl({ vault: vaultId });
    },
  });
  registerUnsavedCheck(() => surface.el.isConnected && surface.hasUnsavedText());

  const footer = page.createDiv({ cls: "vault-capture-page-footer" });
  if (ctx.vaults.length > 1 && target !== "demo") {
    const pick = footer.createEl("select", { cls: "dropdown vault-capture-vault-picker", attr: { "aria-label": "Vault" } });
    for (const v of ctx.vaults) pick.createEl("option", { value: v.id, text: v.name });
    pick.value = target.id;
    pick.addEventListener("change", () => {
      const next = new URL(location.href);
      next.searchParams.set("vault", pick.value);
      next.searchParams.set("text", surface.input.value);
      location.href = next.toString();
    });
  }
  const open = footer.createEl("a", { cls: "vault-capture-open-vault", text: `Open ${vaultName}`, href: appUrl({ vault: vaultId }) });
  open.addEventListener("click", (evt) => {
    evt.preventDefault();
    location.href = appUrl({ vault: vaultId });
  });
  if (!adapter && target !== "demo") {
    footer.createDiv({ cls: "vault-capture-permission", text: "Saving will ask for access to the vault folder." });
  }
  if (target !== "demo") maybeShowSafariStorageBanner({ vaultKind: target.kind, parent: page });

  // Clean the URL so a reload does not refill or re-save.
  const clean = new URL(location.href);
  for (const k of ["text", "share", "title", "url", "save"]) clean.searchParams.delete(k);
  history.replaceState(history.state, "", clean.toString());

  if ((params.get("save") === "1" || params.get("save") === "true") && initialText.trim() && adapter) {
    surface.el.querySelector<HTMLButtonElement>(".vault-capture-save")?.click();
  } else {
    surface.focus();
  }
}
