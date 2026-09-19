/**
 * A streaming ZIP writer: each entry is written to the sink as soon as it is
 * ready, compressed with the browser's `CompressionStream("deflate-raw")`
 * when that makes it smaller, so a backup never holds the whole vault in
 * memory. No ZIP64: entries and archives must stay under 4 GiB.
 */
import { crc32 } from "../publish/zip";

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

const COMPRESSIBLE = new Set(["md", "txt", "json", "canvas", "base", "css", "js", "mjs", "html", "htm", "svg", "csv", "tsv", "xml", "yaml", "yml", "tex", "bib", "ics", "excalidraw", "log"]);

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export class ZipWriter {
  private offset = 0;
  private central: Uint8Array[] = [];
  private count = 0;
  private enc = new TextEncoder();
  private seen = new Set<string>();

  constructor(private sink: ZipSink) {}

  get bytesWritten(): number {
    return this.offset;
  }

  async add(path: string, data: Uint8Array, modified: Date): Promise<void> {
    path = path.replace(/^\/+/, "");
    if (!path || this.seen.has(path)) return;
    if (this.count >= 0xffff) throw new Error("The vault has more than 65,535 files, which this ZIP writer does not support.");
    this.seen.add(path);
    const name = this.enc.encode(path);
    const crc = crc32(data);
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    let method = 0;
    let body = data;
    if (data.length > 256 && COMPRESSIBLE.has(ext)) {
      const packed = await deflateRaw(data);
      if (packed && packed.length < data.length) {
        method = 8;
        body = packed;
      }
    }
    if (this.offset + 30 + name.length + body.length > 0xffffffff) throw new Error("The backup is larger than 4 GB, which this ZIP writer does not support.");
    const { time, date } = dosTime(modified);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, this.offset, true);
    cd.set(name, 46);

    await this.sink.write(local);
    await this.sink.write(body);
    this.central.push(cd);
    this.offset += local.length + body.length;
    this.count++;
  }

  async finish(): Promise<number> {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const c of this.central) {
      await this.sink.write(c);
      cdSize += c.length;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    await this.sink.write(end);
    await this.sink.close();
    return cdStart + cdSize + end.length;
  }
}

/** A sink that collects chunks into a Blob (tests, and browsers without writable file streams). */
export class BlobSink implements ZipSink {
  parts: Uint8Array[] = [];
  blob: Blob | null = null;
  async write(chunk: Uint8Array) {
    this.parts.push(chunk);
  }
  async close() {
    this.blob = new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type: "application/zip" });
    this.parts = [];
  }
  async abort() {
    this.parts = [];
  }
}
