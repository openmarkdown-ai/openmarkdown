/**
 * Settings → AI: the master switch (off by default), what leaves this device,
 * per-feature switches and routing, engines (status, "Test connection", base
 * URLs, models, API keys), and downloaded models with their sizes.
 *
 * Everything here reads and writes `app.ai` (packages/app/src/ai). Keys are
 * written to the AI keychain and never shown again, only their last four
 * characters.
 */
import { describeEngine, FEATURES, type AiProvider, type AiServiceImpl, type RoutedCapability } from "../../ai/index";
import { deleteDownloadedModel, downloadedModels } from "../../ai/engines/transformers";
import { formatBytes } from "../../ai/ui";
import type { App } from "../../obsidian/app";
import { setIcon } from "../../obsidian/ui/icons";
import { Notice } from "../../obsidian/ui/notice";
import type { Setting } from "../../obsidian/ui/setting";
import { confirmModal } from "../helpers";
import { AppSettingTab } from "../tab-base";

const CAP_LABEL: Record<RoutedCapability, string> = { generate: "Text", embed: "Embeddings", transcribe: "Speech" };
const FIELD_LABEL = { baseUrl: "Base URL", model: "Model", embedModel: "Embedding model", transcribeModel: "Speech model" } as const;

export class AiSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "ai", "AI", "lucide-sparkles");
  }

  private get ai(): AiServiceImpl | null {
    return ((this.app as unknown as { ai?: AiServiceImpl }).ai ?? null) as AiServiceImpl | null;
  }

  render(el: HTMLElement): void {
    const ai = this.ai;
    el.addClass("vault-ai-settings");
    if (!ai) {
      el.createDiv({ cls: "setting-item-description", text: "AI is not available in this build." });
      return;
    }
    const c = ai.config;

    const top = this.group(el);
    this.row(top, "Use AI", "Off by default. When on, the features you turn on below use the engines you pick. Nothing runs, downloads or is sent until you use a feature, and the first download or the first time text would leave this device asks you first.")
      .addToggle((t) =>
        t.setValue(c.enabled).onChange((v) => {
          c.enabled = v;
          if (v && !Object.values(c.features).some(Boolean)) for (const f of ["tools", "chat"] as const) c.features[f] = true;
          ai.save();
          this.rerender();
        }),
      )
      .settingEl.addClass("vault-ai-master");

    this.renderSummary(el, ai);
    if (!c.enabled) return;
    this.renderFeatures(el, ai);
    this.renderEngines(el, ai);
    this.renderDownloads(el, ai);
  }

  // ---- what leaves this device ----------------------------------------------------------

  private renderSummary(el: HTMLElement, ai: AiServiceImpl) {
    const box = el.createDiv({ cls: "vault-ai-summary" });
    const head = box.createDiv({ cls: "vault-ai-summary-title" });
    const icon = head.createSpan({ cls: "vault-ai-summary-icon" });
    head.createSpan({ text: "What leaves this device" });
    const list = box.createEl("ul");
    if (!ai.config.enabled) {
      setIcon(icon, "lucide-shield-check");
      box.addClass("mod-private");
      list.createEl("li", { text: "AI is off. Nothing runs, downloads or leaves this device." });
      return;
    }
    const sent: string[] = [];
    const downloads = new Set<string>();
    const local: string[] = [];
    for (const f of FEATURES) {
      if (!ai.config.features[f.id]) continue;
      for (const cap of f.needs) {
        const engine = ai.engineFor(f.id, cap);
        if (!engine) continue;
        const label = describeEngine(engine);
        if (engine.leavesDevice) sent.push(`${f.name}${f.needs.length > 1 ? ` (${CAP_LABEL[cap].toLowerCase()})` : ""}: ${label.replace(/^Sent to /, "sent to ")}, when you use it.`);
        else if (engine.location === "local-server") local.push(`${f.name}: ${label}.`);
        if (engine.provider === "transformers") downloads.add(engine.model);
      }
    }
    if (!sent.length) {
      setIcon(icon, "lucide-shield-check");
      box.addClass("mod-private");
      list.createEl("li", { text: "No text leaves this device: every feature that is on runs here or on a server on this computer." });
    } else {
      setIcon(icon, "lucide-cloud");
      box.addClass("mod-sends");
      for (const s of sent) list.createEl("li", { cls: "mod-sends", text: s });
    }
    for (const l of local) list.createEl("li", { text: l });
    if (downloads.size) list.createEl("li", { text: `Model downloads (once, from Hugging Face, after you agree): ${[...downloads].join(", ")}.` });
    list.createEl("li", { text: "API keys are encrypted in this browser. They are never written to the vault." });
  }

  // ---- features -----------------------------------------------------------------------------

  private renderFeatures(el: HTMLElement, ai: AiServiceImpl) {
    const group = this.group(el, "Features");
    group.getHeader().setDesc("Turn each feature on, and pick where it runs. Automatic uses this device first, then a server on this computer, then a cloud provider you set up.");
    group.addClass("vault-ai-features");
    for (const f of FEATURES) {
      const on = !!ai.config.features[f.id];
      const desc = createFragment();
      desc.appendText(f.desc);
      const engines = desc.createDiv({ cls: "vault-ai-feature-engines" });
      for (const cap of f.needs) {
        const engine = ai.engineFor(f.id, cap) ?? (on ? null : ai.resolve(f.id, cap) && ai.engineOf(ai.resolve(f.id, cap)!, cap));
        const badge = engines.createSpan({ cls: "vault-ai-engine", attr: { "data-location": engine?.location ?? "none" } });
        const i = badge.createSpan({ cls: "vault-ai-engine-icon" });
        setIcon(i, !engine ? "lucide-circle-slash" : engine.leavesDevice ? "lucide-cloud" : engine.location === "local-server" ? "lucide-server" : "lucide-cpu");
        const prefix = f.needs.length > 1 ? `${CAP_LABEL[cap]}: ` : "";
        badge.createSpan({ text: `${prefix}${engine ? describeEngine(engine) : "No engine available"}${engine ? ` · ${engine.model}` : ""}` });
      }
      const row = this.row(group, f.name, desc);
      row.settingEl.addClass("vault-ai-feature");
      row.settingEl.setAttr("data-feature", f.id);
      for (const cap of f.needs) {
        row.addDropdown((d) => {
          d.selectEl.addClass("vault-ai-route");
          d.selectEl.setAttr("data-cap", cap);
          d.selectEl.setAttr("aria-label", `${f.name}: ${CAP_LABEL[cap]} engine`);
          d.addOption("auto", f.needs.length > 1 ? `${CAP_LABEL[cap]}: Automatic` : "Automatic");
          for (const p of ai.listProviders()) {
            if (!this.capabilitiesOf(ai, p).includes(cap)) continue;
            const ready = ai.usable(p, cap);
            d.addOption(p.id, `${f.needs.length > 1 ? `${CAP_LABEL[cap]}: ` : ""}${p.label}${ready ? "" : " (not set up)"}`);
          }
          d.setValue(ai.routeOf(f.id, cap));
          d.onChange((v) => {
            const routes = (ai.config.routes[f.id] ??= {});
            if (v === "auto") delete routes[cap];
            else routes[cap] = v;
            ai.save();
            this.rerender();
          });
        });
      }
      row.addToggle((t) =>
        t.setValue(on).onChange((v) => {
          ai.config.features[f.id] = v;
          ai.save();
          this.rerender();
        }),
      );
    }
  }

  private capabilitiesOf(ai: AiServiceImpl, p: AiProvider): string[] {
    const caps = typeof p.capabilities === "function" ? p.capabilities(ai.settingsOf(p.id)) : p.capabilities;
    return caps;
  }

  // ---- engines --------------------------------------------------------------------------------

  private renderEngines(el: HTMLElement, ai: AiServiceImpl) {
    const group = this.group(el, "Engines");
    group.getHeader().setDesc("On this device, on a server on this computer, or with your own key for a cloud provider.");
    group.addClass("vault-ai-engines");
    for (const p of ai.listProviders()) {
      const s = ai.settingsOf(p.id);
      const engine = ai.engineOf(p, this.capabilitiesOf(ai, p)[0] as RoutedCapability);
      const desc = createFragment();
      const where = desc.createDiv({ cls: "vault-ai-engine", attr: { "data-location": engine.location } });
      setIcon(where.createSpan({ cls: "vault-ai-engine-icon" }), engine.leavesDevice ? "lucide-cloud" : engine.location === "local-server" ? "lucide-server" : "lucide-cpu");
      where.createSpan({ text: engine.leavesDevice ? "Sends text off this device" : engine.location === "local-server" ? "On this computer" : "On this device" });
      if (p.description) desc.createDiv({ text: p.description });
      const statusEl = desc.createDiv({ cls: "vault-ai-provider-status", attr: { "data-state": "unknown" } });
      const row = this.row(group, p.label, desc);
      row.settingEl.addClass("vault-ai-provider");
      row.settingEl.setAttr("data-provider", p.id);
      const setStatus = (state: string, message: string) => {
        statusEl.setAttr("data-state", state);
        statusEl.setText(message);
      };
      const check = async () => {
        setStatus("checking", "Checking…");
        const st = await ai.status(p.id);
        setStatus(st.state, st.message);
        if (st.models?.length) this.offerModels(row, st.models);
        return st;
      };
      if (s.enabled) {
        row.addButton((b) =>
          b.setButtonText("Test connection").onClick(async () => {
            b.setDisabled(true);
            try {
              await check();
            } finally {
              b.setDisabled(false);
            }
          }),
        );
        // Checking a device engine costs nothing; servers and cloud providers are only contacted on request.
        if (engine.location === "device") void check();
        else setStatus("unknown", p.needsKey && !ai.hasKey(p.id) ? "Add an API key." : "Not checked yet.");
      } else setStatus("off", "Off.");
      row.addToggle((t) =>
        t.setValue(s.enabled).onChange((v) => {
          ai.setProviderSettings(p.id, { enabled: v });
          this.rerender();
        }),
      );
      if (!s.enabled) continue;

      for (const field of p.fields ?? []) {
        const stored = ai.config.providers[p.id]?.[field] ?? "";
        const sub = this.row(group, FIELD_LABEL[field]);
        sub.settingEl.addClass("vault-ai-provider-detail");
        sub.settingEl.setAttr("data-field", field);
        sub.addText((t) => {
          t.setPlaceholder(String(p.defaults?.[field] ?? (field === "baseUrl" ? "https://…/v1" : field === "model" ? "(first model the server has)" : "")));
          t.setValue(String(stored));
          t.inputEl.setAttr("spellcheck", "false");
          t.inputEl.setAttr("list", `vault-ai-models-${p.id}`);
          t.onChange((v) => {
            (ai.config.providers[p.id] ??= {})[field] = v.trim();
            ai.forgetConsents(p.id);
            ai.save();
          });
        });
      }
      if (p.needsKey || p.id === "openai-compatible") this.renderKey(group, ai, p);
    }
  }

  private offerModels(row: Setting, models: string[]) {
    const id = row.settingEl.getAttr("data-provider");
    let list = document.getElementById(`vault-ai-models-${id}`);
    if (!list) list = row.settingEl.createEl("datalist", { attr: { id: `vault-ai-models-${id}` } });
    list.empty();
    for (const m of models.slice(0, 200)) list.createEl("option", { attr: { value: m } });
  }

  private renderKey(group: ReturnType<AppSettingTab["group"]>, ai: AiServiceImpl, p: AiProvider) {
    const has = ai.hasKey(p.id);
    const desc = createFragment();
    desc.appendText(has ? "Saved, encrypted in this browser. " : p.needsKey ? "Needed. Kept encrypted in this browser, never in the vault. " : "Only if your server needs one. Kept encrypted in this browser. ");
    if (p.keyUrl) desc.createEl("a", { text: "Get a key", href: p.keyUrl, attr: { target: "_blank", rel: "noopener" } });
    const row = this.row(group, "API key", desc);
    row.settingEl.addClass("vault-ai-provider-detail", "vault-ai-key");
    row.settingEl.setAttr("data-provider", p.id);
    if (has) {
      const masked = row.controlEl.createSpan({ cls: "vault-ai-key-masked", text: "••••••••" });
      void ai.keychain.hint(p.id).then((h) => h && masked.setText(`••••${h}`));
      row.addButton((b) => b.setButtonText("Replace").onClick(() => this.keyInput(row, ai, p)));
      row.addExtraButton((b) =>
        b
          .setIcon("lucide-trash-2")
          .setTooltip("Remove key")
          .onClick(async () => {
            const ok = await confirmModal(this.app, { title: "Remove API key", message: `Remove the ${p.label} key from this browser?`, cta: "Remove", warning: true });
            if (!ok) return;
            await ai.setKey(p.id, null);
            this.rerender();
          }),
      );
    } else this.keyInput(row, ai, p);
  }

  private keyInput(row: Setting, ai: AiServiceImpl, p: AiProvider) {
    row.controlEl.empty();
    let value = "";
    row.addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
      t.inputEl.addClass("vault-ai-key-input");
      t.setPlaceholder("Paste your API key");
      t.onChange((v) => (value = v));
    });
    row.addButton((b) =>
      b
        .setButtonText("Save key")
        .setCta()
        .onClick(async () => {
          if (!value.trim()) return;
          try {
            await ai.setKey(p.id, value);
            value = "";
            new Notice(`${p.label} key saved.`);
          } catch (e) {
            new Notice(`Could not save the key: ${(e as Error).message}`);
          }
          this.rerender();
        }),
    );
  }

  // ---- downloads -------------------------------------------------------------------------------

  private renderDownloads(el: HTMLElement, ai: AiServiceImpl) {
    const group = this.group(el, "Downloaded models");
    group.getHeader().setDesc("On-device models kept in this browser. Deleting one frees the space; it downloads again, after asking, the next time a feature needs it. The browser's built-in models are managed by the browser itself.");
    group.addClass("vault-ai-downloads");
    const placeholder = this.row(group, "Checking…");
    void downloadedModels()
      .catch(() => [])
      .then((models) => {
        placeholder.settingEl.remove();
        if (!models.length) {
          this.row(group, "No models downloaded").settingEl.addClass("vault-ai-download-empty");
          return;
        }
        const total = models.reduce((n, m) => n + m.bytes, 0);
        group.getHeader().setDesc(`On-device models kept in this browser: ${formatBytes(total)} in all. Deleting one frees the space; it downloads again, after asking, the next time a feature needs it.`);
        for (const m of models) {
          const row = this.row(group, m.id, `${formatBytes(m.bytes)} · ${m.files} file${m.files === 1 ? "" : "s"}`);
          row.settingEl.addClass("vault-ai-download");
          row.settingEl.setAttr("data-model", m.id);
          row.addButton((b) =>
            b
              .setButtonText("Delete")
              .setWarning()
              .onClick(async () => {
                const ok = await confirmModal(this.app, { title: "Delete model", message: `Delete ${m.id} (${formatBytes(m.bytes)}) from this browser?`, cta: "Delete", warning: true });
                if (!ok) return;
                await deleteDownloadedModel(m.id);
                ai.forgetConsents("transformers");
                ai.save();
                this.rerender();
              }),
          );
        }
      });
  }
}
