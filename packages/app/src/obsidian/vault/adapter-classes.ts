/**
 * `FileSystemAdapter` and `CapacitorAdapter` exist so `instanceof` checks in
 * plugins compile and run. Plugins use `adapter instanceof FileSystemAdapter`
 * to decide that Node's `fs` and absolute paths are available; in a browser
 * neither is, so no adapter here is an instance of either class.
 */
export class FileSystemAdapter {
  getName(): string {
    return "";
  }
  getBasePath(): string {
    return "";
  }
  static readLocalFile(_path: string): Promise<ArrayBuffer> {
    return Promise.reject(new Error("Local file access is not available in the browser"));
  }
  static mkdir(_path: string): Promise<void> {
    return Promise.reject(new Error("Local file access is not available in the browser"));
  }
}

export class CapacitorAdapter {
  getName(): string {
    return "";
  }
}
