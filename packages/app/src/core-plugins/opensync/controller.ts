/**
 * Sync for one enrolled vault, while this tab is open: when to sync, which tab
 * syncs, what the status is, and what to tell people.
 *
 * When:
 * - a local change syncs after 5 s of quiet, or 60 s into continuous editing;
 * - another device's publish arrives over a live subscription and pulls
 *   immediately — a device that never edits still pulls;
 * - the window regaining focus or coming back online syncs; hiding it flushes;
 * - a slow poll every 5 minutes covers a subscription that silently died;
 * - failures back off from 5 s to 5 minutes.
 */
import { Events } from "../../obsidian/events";
import { Notice } from "../../obsidian/ui/notice";
import { TFile } from "../../obsidian/vault/files";
import type { SyncOutcome } from "@opensync/client";
import type * as EngineModule from "./engine";
import type { AppVaultHost } from "./host";
import { Leadership, type LeaderMessage } from "./leader";
import { appendLog, device as devices, syncDb, unwrap, type DeviceRecord, type Secrets } from "./store";
import { explain, parseConflict, type Attention } from "./words";

const QUIET_MS = 5_000;
const CAP_MS = 60_000;
const POLL_MS = 5 * 60_000;

export type SyncStatus =
  | { state: "starting" }
  | { state: "syncing" }
  | { state: "synced"; at: number }
  | { state: "paused" }
  | { state: "follower"; leader?: SyncStatus }
  | { state: "attention"; kind: Attention; text: string };

export interface ConflictPair {
  path: string;
  copy: string;
  from: string;
  date: string;
}

export interface SeenDevice {
  name: string;
  at: number;
}

export class SyncController extends Events {
  status: SyncStatus = { state: "starting" };
  lastSyncAt: number | null = null;
  /** The relay connection, so a status line can say whether this device can reach the server. */
  connected = false;
  /** The account's public identity (`npub1…`), once the engine is open. */
  npub: string | null = null;
  /** What the last completed sync did, for the status line and the log. */
  lastOutcome: { at: number; kind: string; pulled: number; deleted: number; pushed: number; conflicts: number } | null = null;
  lastError: string | null = null;
  pending = new Set<string>();
  conflicts: ConflictPair[] = [];
  heldBack: string[] = [];
  record: DeviceRecord;

  private engine: typeof EngineModule | null = null;
  private secrets: Secrets | null = null;
  private sync: EngineModule.VaultSync | null = null;
  private host: AppVaultHost | null = null;
  private leadership: Leadership;
  private unwatch: (() => void) | null = null;
  private timer: number | null = null;
  private dueAt = 0;
  private dueIsQuiet = false;
  private firstDirtyAt = 0;
  private failures = 0;
  private stopped = false;
  private followerDirty = false;
  private pendingTimer: number | null = null;
  private cleanups: (() => void)[] = [];
  private notifiedConflicts = new Set<string>();

  constructor(
    readonly app: any,
    record: DeviceRecord,
  ) {
    super();
    this.record = record;
    this.leadership = new Leadership(record.vaultId, {
      onLeader: () => void this.becomeLeader(),
      onFollower: () => this.setStatus({ state: "follower" }),
      onMessage: (m) => void this.onMessage(m),
    });
  }

  /** Nothing scheduled and nothing running: every local change so far has been synced or failed. */
  get idle(): boolean {
    return this.timer === null && this.inFlight === null;
  }

  get isLeader(): boolean {
    return this.leadership.isLeader;
  }

  get vaultId(): string {
    return this.record.vaultId;
  }

  async start(): Promise<void> {
    this.engine = await import("./engine");
    this.secrets = await unwrap(this.record.wrapped);
    if (this.record.paused) this.setStatus({ state: "paused" });
    this.leadership.start();
    this.refreshConflicts();

    const vault = this.app.vault;
    const onVaultChange = (f: unknown) => {
      if (!(f instanceof TFile)) return;
      this.schedulePending();
      this.refreshConflictsSoon();
      if (!this.leadership.isLeader) this.leadership.post({ t: "dirty", path: f.path });
    };
    const refs = ["create", "modify", "delete", "rename"].map((ev) => vault.on(ev, onVaultChange));
    this.cleanups.push(() => refs.forEach((r: unknown) => vault.offref(r)));

    const onFocus = () => this.request(500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") this.request(500);
      else if (this.timer !== null) this.request(0);
    };
    const onOnline = () => this.request(0);
    const onUnload = (e: BeforeUnloadEvent) => {
      if (this.leadership.isLeader && this.timer !== null && this.status.state !== "paused") {
        void this.runNow();
        e.preventDefault();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onUnload);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") this.request(0);
    }, POLL_MS);
    this.cleanups.push(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onUnload);
      window.clearInterval(poll);
    });
  }

  private async becomeLeader(): Promise<void> {
    if (this.stopped || !this.engine || !this.secrets) return;
    try {
      const { sync, host } = await this.engine.openSync(this.app, this.record, this.secrets, () => this.onLocalChange());
      if (this.stopped) {
        sync.close();
        return;
      }
      this.sync = sync;
      this.host = host;
      this.npub = sync.npub;
      this.connected = sync.connected;
      const unwatchConnection = sync.onConnectionChange((connected: boolean) => {
        if (this.connected === connected) return;
        this.connected = connected;
        this.trigger("connection", connected);
        this.trigger("status", this.status);
      });
      const unwatchPointer = sync.watch(() => this.request(250));
      this.unwatch = () => {
        unwatchConnection();
        unwatchPointer();
      };
      if (this.status.state !== "paused") this.setStatus({ state: "starting" });
      const saved = await syncDb.get<{ lastSyncAt?: number }>(`meta:${this.vaultId}`);
      this.lastSyncAt = saved?.lastSyncAt ?? null;
      this.app.workspace.onLayoutReady(() => this.request(0));
      void this.refreshPending();
    } catch (e) {
      this.fail(e);
    }
  }

  private onLocalChange(): void {
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    const cap = this.firstDirtyAt + CAP_MS - now;
    this.request(Math.max(0, Math.min(QUIET_MS, cap)), true);
  }

  /** Ask for a sync in `delay` ms. A quiet-period request pushes a later one back; others only bring it forward. */
  request(delay: number, quiet = false): void {
    if (this.stopped) return;
    if (!this.leadership.isLeader) {
      if (delay === 0) this.leadership.post({ t: "sync-now" });
      return;
    }
    if (this.record.paused) return;
    const due = Date.now() + delay;
    if (this.timer !== null) {
      // A quiet period may push a quiet sync back, never an urgent one; an
      // urgent request only ever brings the next sync forward.
      if (quiet ? !this.dueIsQuiet && this.dueAt <= due : due >= this.dueAt) return;
      window.clearTimeout(this.timer);
    }
    this.dueAt = due;
    this.dueIsQuiet = quiet;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, delay);
  }

  /** Sync now and say how it went. Runs in the leader; a follower forwards the request. */
  async runNow(): Promise<SyncOutcome | null> {
    if (!this.leadership.isLeader) {
      this.leadership.post({ t: "sync-now" });
      return null;
    }
    const sync = this.sync;
    if (!sync || this.stopped || this.record.paused) return null;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    // One run at a time. A trigger during a run asks for one more afterwards,
    // through `request`, which checks pause again: a run queued inside the
    // engine would otherwise publish edits made after the user paused.
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.runOnce(sync).finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.request(0);
      }
    });
    return this.inFlight;
  }

  private inFlight: Promise<SyncOutcome | null> | null = null;
  private again = false;

  private async runOnce(sync: EngineModule.VaultSync): Promise<SyncOutcome | null> {
    this.firstDirtyAt = 0;
    this.setStatus({ state: "syncing" });
    try {
      await this.host?.flushEditors();
      if (this.followerDirty) {
        this.followerDirty = false;
        await this.app.vault.sync?.();
      }
      const outcome = await sync.sync();
      this.failures = 0;
      this.lastError = null;
      this.lastSyncAt = Date.now();
      await syncDb.set(`meta:${this.vaultId}`, { lastSyncAt: this.lastSyncAt });
      this.heldBack = outcome.heldBack;
      this.lastOutcome = {
        at: this.lastSyncAt,
        kind: outcome.kind,
        pulled: outcome.pulled.length,
        deleted: outcome.deleted.length,
        pushed: outcome.pushed ?? 0,
        conflicts: outcome.conflicts.length,
      };
      if (this.record.pullOnOpen) this.record = (await devices.update(this.vaultId, { pullOnOpen: false })) ?? this.record;
      await this.afterOutcome(outcome);
      this.setStatus(this.record.paused ? { state: "paused" } : { state: "synced", at: this.lastSyncAt });
      return outcome;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  private async afterOutcome(outcome: SyncOutcome): Promise<void> {
    const changed = [...outcome.pulled, ...outcome.deleted];
    if (changed.length) this.leadership.post({ t: "applied", paths: changed });
    if (outcome.kind !== "up-to-date") {
      const parts: string[] = [];
      if (outcome.pulled.length) parts.push(`${outcome.pulled.length} received`);
      if (outcome.deleted.length) parts.push(`${outcome.deleted.length} deleted`);
      if (outcome.pushed) parts.push(`${outcome.pushed} uploaded`);
      if (outcome.conflicts.length) parts.push(`${outcome.conflicts.length} conflict${outcome.conflicts.length === 1 ? "" : "s"}`);
      await appendLog(this.vaultId, {
        at: Date.now(),
        kind: outcome.kind,
        text: `${label(outcome.kind)}${parts.length ? ` — ${parts.join(", ")}` : ""} (version ${outcome.generation})`,
        paths: [...outcome.pulled, ...outcome.deleted.map((p: string) => `deleted: ${p}`)].slice(0, 50),
      });
    }
    await this.rememberDevices();
    this.refreshConflicts();
    await this.refreshPending();
  }

  private async rememberDevices(): Promise<void> {
    const state = await syncDb.get<{ base?: { device?: string; updated_at?: number } }>(`state:${this.vaultId}`);
    const key = `devices:${this.vaultId}`;
    const seen = (await syncDb.get<SeenDevice[]>(key)) ?? [];
    const upsert = (name: string | undefined, at: number) => {
      if (!name) return;
      const existing = seen.find((d) => d.name === name);
      if (existing) existing.at = Math.max(existing.at, at);
      else seen.push({ name, at });
    };
    upsert(this.record.deviceLabel, Date.now());
    const base = state?.base;
    if (base?.device) upsert(base.device, (base.updated_at ?? 0) * 1000 || Date.now());
    await syncDb.set(key, seen);
  }

  async seenDevices(): Promise<SeenDevice[]> {
    return ((await syncDb.get<SeenDevice[]>(`devices:${this.vaultId}`)) ?? []).sort((a, b) => b.at - a.at);
  }

  private fail(e: unknown): void {
    const { kind, text } = explain(e, this.record.relayWs);
    console.warn("Sync:", e);
    this.lastError = text;
    const repeated = this.status.state === "attention" && this.status.text === text;
    this.setStatus({ state: "attention", kind, text });
    if (!repeated) void appendLog(this.vaultId, { at: Date.now(), kind: "error", text });
    this.failures += 1;
    const permanent = kind === "not-admitted" || kind === "quota" || kind === "locked-out";
    const delay = permanent ? POLL_MS : Math.min(POLL_MS, 5_000 * 2 ** Math.min(this.failures - 1, 6));
    if (!repeated && (kind === "quota" || kind === "not-admitted")) new Notice(`Sync: ${text}`, 10_000);
    this.request(delay);
  }

  private async onMessage(m: LeaderMessage): Promise<void> {
    if (this.stopped) return;
    if (this.leadership.isLeader) {
      if (m.t === "dirty") {
        this.followerDirty = true;
        this.onLocalChange();
      } else if (m.t === "sync-now") {
        this.request(0);
      } else if (m.t === "hello") {
        this.leadership.post({ t: "status", status: this.status });
      }
      return;
    }
    if (m.t === "applied") {
      // The leader wrote to the storage this tab shares; catch up with it.
      await this.app.vault.sync?.();
    } else if (m.t === "status") {
      this.setStatus({ state: "follower", leader: m.status as SyncStatus });
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.stopped) return;
    this.status = status;
    if (this.leadership.isLeader) this.leadership.post({ t: "status", status });
    this.trigger("status", status);
  }

  async setPaused(paused: boolean): Promise<void> {
    this.record = (await devices.update(this.vaultId, { paused })) ?? this.record;
    if (paused) {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
      // "Paused" is only shown once nothing is running: a sync already under
      // way finishes first, and nothing typed after this point is sent.
      this.again = false;
      await this.inFlight?.catch(() => undefined);
      this.setStatus({ state: "paused" });
    } else {
      this.setStatus(this.lastSyncAt ? { state: "synced", at: this.lastSyncAt } : { state: "starting" });
      this.request(0);
    }
  }

  /** Recompute which files differ from the last sync, for explorer badges. */
  private schedulePending(): void {
    if (this.pendingTimer !== null) return;
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      void this.refreshPending();
    }, 800);
  }

  private async refreshPending(): Promise<void> {
    if (!this.sync) return;
    try {
      this.pending = new Set(await this.sync.pending());
      this.trigger("pending", this.pending);
    } catch {
      /* the next sync recomputes */
    }
  }

  private conflictTimer: number | null = null;
  private refreshConflictsSoon(): void {
    if (this.conflictTimer !== null) return;
    this.conflictTimer = window.setTimeout(() => {
      this.conflictTimer = null;
      this.refreshConflicts();
    }, 300);
  }

  /** Conflict copies are files; the list is whatever copies still exist, minus the ones kept on purpose. */
  refreshConflicts(): Promise<void> {
    return (async () => {
      const dismissed = new Set((await syncDb.get<string[]>(`dismissed:${this.vaultId}`)) ?? []);
      const pairs: ConflictPair[] = [];
      for (const f of this.app.vault.getFiles() as TFile[]) {
        const parsed = parseConflict(f.path);
        if (!parsed || dismissed.has(f.path)) continue;
        pairs.push({ path: parsed.original, copy: f.path, from: parsed.from, date: parsed.date });
      }
      const fresh = pairs.filter((p) => !this.notifiedConflicts.has(p.copy));
      this.conflicts = pairs;
      this.trigger("conflicts", pairs);
      if (fresh.length && this.leadership.isLeader) {
        for (const p of fresh) this.notifiedConflicts.add(p.copy);
        const frag = document.createDocumentFragment();
        frag.createSpan({ text: `Sync: ${fresh.length} conflict${fresh.length === 1 ? "" : "s"} — both versions kept. ` });
        const review = frag.createEl("a", { text: "Review", href: "#" });
        review.addEventListener("click", (e) => {
          e.preventDefault();
          this.trigger("review-conflicts");
        });
        new Notice(frag, 10_000);
      }
    })();
  }

  async dismissConflict(copy: string): Promise<void> {
    const key = `dismissed:${this.vaultId}`;
    const list = (await syncDb.get<string[]>(key)) ?? [];
    if (!list.includes(copy)) list.push(copy);
    await syncDb.set(key, list);
    this.refreshConflicts();
  }

  get secretsForUi(): Secrets | null {
    return this.secrets;
  }

  get engineModule(): typeof EngineModule | null {
    return this.engine;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.unwatch?.();
    this.sync?.close();
    this.sync = null;
    this.connected = false;
    this.leadership.stop();
    for (const c of this.cleanups.splice(0)) c();
  }
}

function label(kind: SyncOutcome["kind"]): string {
  return kind === "pulled" ? "Received changes" : kind === "published" ? "Sent changes" : kind === "merged" ? "Merged with another device" : "Up to date";
}
