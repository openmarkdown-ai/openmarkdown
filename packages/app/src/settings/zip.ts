/**
 * A minimal ZIP reader for "Install from files…": reads the central directory
 * and inflates stored or deflated entries with the browser's own
 * `DecompressionStream("deflate-raw")`. Enough for a plugin release archive;
 * no ZIP64, no encryption.
 */

export interface ZipEntry {
  path: string;
  read(): Promise<Uint8Array>;
}

export async function readZip(data: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  // End of central directory: signature 0x06054b50, within the last 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    entries.push({
      path,
      read: async () => {
        if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Corrupt zip entry ${path}`);
        const localName = view.getUint16(localOffset + 26, true);
        const localExtra = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localName + localExtra;
        const raw = bytes.slice(start, start + compressedSize);
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`Unsupported compression in ${path}`);
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return entries;
}
