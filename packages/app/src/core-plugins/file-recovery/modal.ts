/**
 * The File recovery modal: files with snapshots on the left, that file's
 * snapshots in the middle, a preview (or the changes against the current
 * file) on the right, with Copy and Restore.
 */
import { ConfirmationModal, Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { setIcon } from "../../obsidian/ui/icons";
import { moment } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import { diffLineOps, type DiffLine } from "./diff";
import type { Snapshot, SnapshotStore } from "./store";

export interface RecoveryHost {
  app: any;
  store: SnapshotStore;
  /** Snapshot the file's current content before it is overwritten. */
  snapshotNow(path: string, data: string): Promise<void>;
}

const SHOW_CHANGES_KEY = "file-recovery-show-changes";
const SIDE_BY_SIDE_KEY = "file-recovery-side-by-side";

export class FileRecoveryModal extends Modal {
  private filterEl!: HTMLInputElement;
  private filesEl!: HTMLElement;
  private snapshotsEl!: HTMLElement;
  private previewTitleEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private copyBtn!: HTMLButtonElement;
  private restoreBtn!: HTMLButtonElement;
  private changesToggle!: HTMLInputElement;
  private sideToggle!: HTMLInputElement;
  private sideLabel!: HTMLElement;

  private paths: { path: string; latest: number; count: number }[] = [];
  private selectedPath: string | null = null;
  private snapshots: Snapshot[] = [];
  private selectedSnapshot: Snapshot | null = null;
  private currentText: string | null = null;
  private renderSeq = 0;

  constructor(
    private host: RecoveryHost,
    private initialPath: string | null = null,
  ) {
    super(host.app);
    this.modalEl.addClass("vault-file-recovery-modal");
    this.setTitle("File recovery");
  }

  override async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const root = contentEl.createDiv({ cls: "vault-file-recovery" });

    const filesPane = root.createDiv({ cls: "vault-file-recovery-pane vault-file-recovery-files-pane" });
    const search = filesPane.createDiv({ cls: "search-input-container" });
    this.filterEl = search.createEl("input", { type: "search", attr: { placeholder: "Filter files...", spellcheck: "false" } });
    this.filterEl.addEventListener("input", () => this.renderFiles());
    this.filterEl.addEventListener("keydown", (evt) => {
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        this.filesEl.focus();
        this.moveFile(0);
      }
    });
    this.filesEl = filesPane.createDiv({ cls: "vault-file-recovery-list", attr: { tabindex: "0", role: "listbox", "aria-label": "Files" } });
    this.filesEl.addEventListener("keydown", (evt) => this.onListKey(evt, (d) => this.moveFile(d), () => this.snapshotsEl.focus()));

    const snapsPane = root.createDiv({ cls: "vault-file-recovery-pane vault-file-recovery-snapshots-pane" });
    this.snapshotsEl = snapsPane.createDiv({ cls: "vault-file-recovery-list", attr: { tabindex: "0", role: "listbox", "aria-label": "Snapshots" } });
    this.snapshotsEl.addEventListener("keydown", (evt) =>
      this.onListKey(
        evt,
        (d) => this.moveSnapshot(d),
        () => this.previewEl.focus(),
        () => this.filesEl.focus(),
      ),
    );

    const previewPane = root.createDiv({ cls: "vault-file-recovery-pane vault-file-recovery-preview-pane" });
    const toolbar = previewPane.createDiv({ cls: "vault-file-recovery-toolbar" });
    this.previewTitleEl = toolbar.createDiv({ cls: "vault-file-recovery-preview-title" });
    const controls = toolbar.createDiv({ cls: "vault-file-recovery-controls" });
    const changesLabel = controls.createEl("label", { cls: "vault-file-recovery-check" });
    this.changesToggle = changesLabel.createEl("input", { type: "checkbox" });
    changesLabel.appendText("Show changes");
    this.sideLabel = controls.createEl("label", { cls: "vault-file-recovery-check" });
    this.sideToggle = this.sideLabel.createEl("input", { type: "checkbox" });
    this.sideLabel.appendText("Side by side");
    this.changesToggle.checked = !!this.app.loadLocalStorage(SHOW_CHANGES_KEY);
    this.sideToggle.checked = !!this.app.loadLocalStorage(SIDE_BY_SIDE_KEY);
    this.changesToggle.addEventListener("change", () => {
      this.app.saveLocalStorage(SHOW_CHANGES_KEY, this.changesToggle.checked || null);
      void this.renderPreview();
    });
    this.sideToggle.addEventListener("change", () => {
      this.app.saveLocalStorage(SIDE_BY_SIDE_KEY, this.sideToggle.checked || null);
      void this.renderPreview();
    });
    this.copyBtn = controls.createEl("button", { text: "Copy", attr: { "aria-label": "Copy to clipboard" } });
    this.copyBtn.addEventListener("click", () => void this.copy());
    this.restoreBtn = controls.createEl("button", { cls: "mod-cta", text: "Restore" });
    this.restoreBtn.addEventListener("click", () => this.confirmRestore());
    this.previewEl = previewPane.createDiv({ cls: "vault-file-recovery-preview", attr: { tabindex: "0" } });

    await this.host.store.load();
    this.paths = this.host.store.paths();
    this.renderFiles();
    const initial = this.initialPath && this.paths.some((p) => p.path === this.initialPath) ? this.initialPath : (this.visiblePaths()[0]?.path ?? null);
    if (initial) await this.selectFile(initial);
    else this.renderEmptyPreview();
    (initial ? this.snapshotsEl : this.filterEl).focus();
  }

  private onListKey(evt: KeyboardEvent, move: (delta: number) => void, right?: () => void, left?: () => void) {
    if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
      evt.preventDefault();
      evt.stopPropagation();
      move(evt.key === "ArrowDown" ? 1 : -1);
    } else if (evt.key === "ArrowRight" && right) {
      evt.preventDefault();
      right();
    } else if (evt.key === "ArrowLeft" && left) {
      evt.preventDefault();
      left();
    } else if (evt.key === "Home" || evt.key === "End") {
      evt.preventDefault();
      move(evt.key === "Home" ? -Infinity : Infinity);
    }
  }

  private visiblePaths() {
    const q = this.filterEl?.value.trim().toLowerCase() ?? "";
    return q ? this.paths.filter((p) => p.path.toLowerCase().includes(q)) : this.paths;
  }

  private renderFiles() {
    this.filesEl.empty();
    const visible = this.visiblePaths();
    if (!visible.length) {
      this.filesEl.createDiv({ cls: "vault-file-recovery-empty", text: this.paths.length ? "No matching files." : "No snapshots yet." });
      return;
    }
    for (const p of visible) {
      const exists = !!this.app.vault.getFileByPath(p.path);
      const item = this.filesEl.createDiv({ cls: "vault-file-recovery-item", attr: { role: "option", "data-path": p.path } });
      item.toggleClass("is-selected", p.path === this.selectedPath);
      item.toggleClass("is-deleted", !exists);
      const name = p.path.slice(p.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      item.createDiv({ cls: "vault-file-recovery-item-title", text: name });
      const folder = p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "";
      item.createDiv({ cls: "vault-file-recovery-item-note", text: `${folder ? folder + " · " : ""}${p.count} ${p.count === 1 ? "snapshot" : "snapshots"}${exists ? "" : " · deleted"}` });
      item.setAttr("title", p.path);
      item.addEventListener("click", () => void this.selectFile(p.path));
    }
  }

  private moveFile(delta: number) {
    const visible = this.visiblePaths();
    if (!visible.length) return;
    const i = visible.findIndex((p) => p.path === this.selectedPath);
    const next = clampIndex(i === -1 ? (delta > 0 ? -1 : visible.length) : i, delta, visible.length);
    void this.selectFile(visible[next]!.path);
  }

  private async selectFile(path: string) {
    this.selectedPath = path;
    this.filesEl.querySelectorAll<HTMLElement>(".vault-file-recovery-item").forEach((el) => {
      const on = el.getAttr("data-path") === path;
      el.toggleClass("is-selected", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
    const seq = ++this.renderSeq;
    const file = this.app.vault.getFileByPath(path);
    this.currentText = file instanceof TFile ? await this.app.vault.read(file) : null;
    const snaps = await this.host.store.list(path);
    if (seq !== this.renderSeq) return;
    this.snapshots = snaps;
    this.selectedSnapshot = snaps[0] ?? null;
    this.renderSnapshots();
    await this.renderPreview();
  }

  private renderSnapshots() {
    this.snapshotsEl.empty();
    if (!this.snapshots.length) {
      this.snapshotsEl.createDiv({ cls: "vault-file-recovery-empty", text: "No snapshots." });
      return;
    }
    let lastDay = "";
    this.snapshots.forEach((snap, i) => {
      const m = moment(snap.ts);
      const day = m.format("dddd, MMMM D, YYYY");
      if (day !== lastDay) {
        this.snapshotsEl.createDiv({ cls: "vault-file-recovery-day", text: day });
        lastDay = day;
      }
      const item = this.snapshotsEl.createDiv({ cls: "vault-file-recovery-item", attr: { role: "option", "data-index": String(i) } });
      item.toggleClass("is-selected", snap === this.selectedSnapshot);
      item.createDiv({ cls: "vault-file-recovery-item-title", text: m.format("HH:mm:ss") });
      const same = this.currentText !== null && snap.data === this.currentText;
      item.createDiv({ cls: "vault-file-recovery-item-note", text: `${m.fromNow()} · ${snap.data.length.toLocaleString()} characters${same ? " · same as current" : ""}` });
      item.addEventListener("click", () => this.selectSnapshot(i));
    });
  }

  private moveSnapshot(delta: number) {
    if (!this.snapshots.length) return;
    const i = this.selectedSnapshot ? this.snapshots.indexOf(this.selectedSnapshot) : -1;
    this.selectSnapshot(clampIndex(i, delta, this.snapshots.length));
  }

  private selectSnapshot(i: number) {
    const snap = this.snapshots[i];
    if (!snap) return;
    this.selectedSnapshot = snap;
    this.snapshotsEl.querySelectorAll<HTMLElement>(".vault-file-recovery-item").forEach((el) => {
      const on = el.getAttr("data-index") === String(i);
      el.toggleClass("is-selected", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
    void this.renderPreview();
  }

  private renderEmptyPreview() {
    this.previewTitleEl.setText("");
    this.previewEl.empty();
    const empty = this.previewEl.createDiv({ cls: "vault-file-recovery-empty" });
    setIcon(empty.createDiv({ cls: "vault-file-recovery-empty-icon" }), "lucide-history");
    empty.createDiv({ text: "Snapshots of your notes appear here as you edit them." });
    this.copyBtn.disabled = true;
    this.restoreBtn.disabled = true;
    this.sideLabel.toggle(false);
  }

  private async renderPreview() {
    const snap = this.selectedSnapshot;
    if (!snap) {
      this.renderEmptyPreview();
      return;
    }
    this.copyBtn.disabled = false;
    this.restoreBtn.disabled = false;
    this.previewTitleEl.setText(`${snap.path} — ${moment(snap.ts).format("YYYY-MM-DD HH:mm:ss")}`);
    this.previewEl.empty();
    const showChanges = this.changesToggle.checked;
    this.sideLabel.toggle(showChanges);
    if (!showChanges) {
      this.previewEl.createEl("pre", { cls: "vault-file-recovery-text", text: snap.data });
      return;
    }
    const current = this.currentText ?? "";
    const ops = diffLineOps(snap.data, current);
    const legend = this.previewEl.createDiv({ cls: "vault-file-recovery-legend" });
    legend.createSpan({ cls: "mod-removed", text: "Only in snapshot" });
    legend.createSpan({ cls: "mod-added", text: this.currentText === null ? "Only in current file (file is deleted)" : "Only in current file" });
    if (!ops.some((o) => o.type !== "equal")) {
      this.previewEl.createDiv({ cls: "vault-file-recovery-empty", text: "This snapshot is identical to the current file." });
      return;
    }
    if (this.sideToggle.checked) this.renderSideBySide(ops);
    else this.renderUnified(ops);
  }

  private renderUnified(ops: DiffLine[]) {
    const table = this.previewEl.createDiv({ cls: "vault-diff vault-diff-unified" });
    let oldNo = 0;
    let newNo = 0;
    for (const op of ops) {
      const row = table.createDiv({ cls: "vault-diff-line" });
      if (op.type !== "insert") oldNo++;
      if (op.type !== "delete") newNo++;
      if (op.type === "insert") row.addClass("mod-added");
      if (op.type === "delete") row.addClass("mod-removed");
      row.createSpan({ cls: "vault-diff-gutter", text: op.type === "insert" ? "" : String(oldNo) });
      row.createSpan({ cls: "vault-diff-gutter", text: op.type === "delete" ? "" : String(newNo) });
      row.createSpan({ cls: "vault-diff-sign", text: op.type === "insert" ? "+" : op.type === "delete" ? "−" : " " });
      row.createSpan({ cls: "vault-diff-text", text: op.line || " " });
    }
  }

  private renderSideBySide(ops: DiffLine[]) {
    const table = this.previewEl.createDiv({ cls: "vault-diff vault-diff-split" });
    const header = table.createDiv({ cls: "vault-diff-row vault-diff-header" });
    header.createDiv({ cls: "vault-diff-cell", text: "Snapshot" });
    header.createDiv({ cls: "vault-diff-cell", text: "Current" });
    let oldNo = 0;
    let newNo = 0;
    const cell = (row: HTMLElement, cls: string, no: number | null, text: string | null) => {
      const c = row.createDiv({ cls: `vault-diff-cell ${cls}` });
      c.createSpan({ cls: "vault-diff-gutter", text: no === null ? "" : String(no) });
      c.createSpan({ cls: "vault-diff-text", text: text === null ? "" : text || " " });
      if (text === null) c.addClass("is-empty");
    };
    for (let i = 0; i < ops.length; ) {
      const op = ops[i]!;
      if (op.type === "equal") {
        const row = table.createDiv({ cls: "vault-diff-row" });
        cell(row, "", ++oldNo, op.line);
        cell(row, "", ++newNo, op.line);
        i++;
        continue;
      }
      const dels: string[] = [];
      const ins: string[] = [];
      while (i < ops.length && ops[i]!.type !== "equal") {
        (ops[i]!.type === "delete" ? dels : ins).push(ops[i]!.line);
        i++;
      }
      for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
        const row = table.createDiv({ cls: "vault-diff-row" });
        const d = dels[k];
        const n = ins[k];
        cell(row, d === undefined ? "" : "mod-removed", d === undefined ? null : ++oldNo, d ?? null);
        cell(row, n === undefined ? "" : "mod-added", n === undefined ? null : ++newNo, n ?? null);
      }
    }
  }

  private async copy() {
    const snap = this.selectedSnapshot;
    if (!snap) return;
    try {
      await navigator.clipboard.writeText(snap.data);
      new Notice("Copied to clipboard.");
    } catch (e) {
      new Notice(`Could not copy: ${(e as Error).message ?? e}`);
    }
  }

  private confirmRestore() {
    const snap = this.selectedSnapshot;
    if (!snap) return;
    const name = snap.path.slice(snap.path.lastIndexOf("/") + 1);
    const exists = !!this.app.vault.getFileByPath(snap.path);
    const modal = new ConfirmationModal(this.app);
    modal.setTitle("Restore snapshot");
    modal.setContent(
      exists
        ? `Replace the contents of “${name}” with the snapshot from ${moment(snap.ts).format("YYYY-MM-DD HH:mm:ss")}? The current contents are saved as a new snapshot first.`
        : `“${name}” no longer exists. Recreate it from the snapshot from ${moment(snap.ts).format("YYYY-MM-DD HH:mm:ss")}?`,
    );
    modal.addButton((b) => b.setButtonText("Restore").setCta().onClick(() => this.restore(snap)));
    modal.addCancelButton();
    modal.open();
  }

  private async restore(snap: Snapshot) {
    const vault = this.app.vault;
    try {
      const file = vault.getFileByPath(snap.path);
      if (file instanceof TFile) {
        const current = await vault.read(file);
        if (current !== snap.data) await this.host.snapshotNow(snap.path, current);
        await vault.modify(file, snap.data);
      } else {
        const dir = snap.path.includes("/") ? snap.path.slice(0, snap.path.lastIndexOf("/")) : "";
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        await vault.create(snap.path, snap.data);
      }
      new Notice(`Restored “${snap.path}”.`);
      this.paths = this.host.store.paths();
      this.renderFiles();
      await this.selectFile(snap.path);
    } catch (e) {
      console.error(e);
      new Notice(`Could not restore: ${(e as Error).message ?? e}`);
    }
  }
}

function clampIndex(i: number, delta: number, n: number): number {
  if (delta === Infinity) return n - 1;
  if (delta === -Infinity) return 0;
  return Math.min(n - 1, Math.max(0, i + delta));
}
