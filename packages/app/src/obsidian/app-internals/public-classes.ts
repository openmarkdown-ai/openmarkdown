/** Small public classes from obsidian.d.ts that have no better home. */
import { Events } from "../events";

export class SecretStorage extends Events {
  constructor(private app: { loadLocalStorage(k: string): any; saveLocalStorage(k: string, v: unknown): void }) {
    super();
  }
  private all(): Record<string, string> {
    return this.app.loadLocalStorage("secret-storage") ?? {};
  }
  getSecret(id: string): string | null {
    return this.all()[id] ?? null;
  }
  setSecret(id: string, secret: string): void {
    const all = this.all();
    all[id] = secret;
    this.app.saveLocalStorage("secret-storage", all);
    this.trigger("changed", id);
  }
  // internal: the Keychain settings tab
  removeSecret(id: string): void {
    const all = this.all();
    delete all[id];
    this.app.saveLocalStorage("secret-storage", all);
    this.trigger("changed", id);
  }
  listSecrets(): string[] {
    return Object.keys(this.all());
  }
}

/** Work to finish before the app quits (`workspace.on("quit", tasks => …)`). */
export class Tasks {
  private promises: Promise<unknown>[] = [];
  add(callback: () => Promise<any>): void {
    this.promises.push(callback());
  }
  addPromise(promise: Promise<any>): void {
    this.promises.push(promise);
  }
  isEmpty(): boolean {
    return this.promises.length === 0;
  }
  promise(): Promise<any> {
    return Promise.all(this.promises);
  }
}

export class RenderContext {
  hoverPopover: unknown = null;
}
