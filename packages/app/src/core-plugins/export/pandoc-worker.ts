/**
 * Runs pandoc.wasm (the Pandoc project's official WebAssembly build) in a
 * worker so a long conversion never freezes the app. The binary is GPL and is
 * never bundled: the page downloads it after the user agrees and hands the
 * bytes to this worker, which only invokes it.
 *
 * pandoc.wasm is a WASI program exporting `convert(ptr, len)`: it reads a
 * pandoc defaults document (JSON) from memory, and uses `stdin`, `stdout`,
 * `stderr`, `warnings` plus any input/output files in its root directory.
 */
import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, type Inode } from "@bjorn3/browser_wasi_shim";

export interface PandocRequest {
  wasm: ArrayBuffer | WebAssembly.Module;
  options: Record<string, unknown>;
  stdin: string;
  files: Record<string, Uint8Array>;
}

export interface PandocResponse {
  ok: boolean;
  output?: Uint8Array;
  stdout?: string;
  stderr?: string;
  warnings?: string;
  error?: string;
}

async function run(req: PandocRequest): Promise<PandocResponse> {
  const args = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"];
  const root = new Map<string, Inode>();
  const wasi = new WASI(args, [], [new OpenFile(new File(new Uint8Array(), { readonly: true })), ConsoleStdout.lineBuffered(() => {}), ConsoleStdout.lineBuffered(() => {}), new PreopenDirectory("/", root)]);
  const module = req.wasm instanceof WebAssembly.Module ? req.wasm : await WebAssembly.compile(req.wasm);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport as unknown as WebAssembly.ModuleImports });
  const ex = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    malloc(n: number): number;
    __wasm_call_ctors(): void;
    hs_init_with_rtsopts(argc: number, argv: number): void;
    convert(ptr: number, len: number): void;
  };
  wasi.initialize(instance as unknown as { exports: { memory: WebAssembly.Memory; _initialize?: () => unknown } });
  ex.__wasm_call_ctors();

  const enc = new TextEncoder();
  const cString = (s: string) => {
    const bytes = enc.encode(s);
    const ptr = ex.malloc(bytes.length + 1);
    const mem = new Uint8Array(ex.memory.buffer);
    mem.set(bytes, ptr);
    mem[ptr + bytes.length] = 0;
    return ptr;
  };
  const argc = ex.malloc(4);
  new DataView(ex.memory.buffer).setUint32(argc, args.length, true);
  const argvArray = ex.malloc(4 * (args.length + 1));
  args.forEach((a, i) => {
    const p = cString(a);
    new DataView(ex.memory.buffer).setUint32(argvArray + 4 * i, p, true);
  });
  new DataView(ex.memory.buffer).setUint32(argvArray + 4 * args.length, 0, true);
  const argv = ex.malloc(4);
  new DataView(ex.memory.buffer).setUint32(argv, argvArray, true);
  ex.hs_init_with_rtsopts(argc, argv);

  const stdin = new File(enc.encode(req.stdin), { readonly: true });
  const stdout = new File(new Uint8Array(), { readonly: false });
  const stderr = new File(new Uint8Array(), { readonly: false });
  const warnings = new File(new Uint8Array(), { readonly: false });
  root.set("stdin", stdin);
  root.set("stdout", stdout);
  root.set("stderr", stderr);
  root.set("warnings", warnings);
  for (const [name, data] of Object.entries(req.files)) {
    // Resource paths may contain folders (attachments/…).
    const parts = name.split("/");
    let dir = root;
    for (const seg of parts.slice(0, -1)) {
      let next = dir.get(seg);
      if (!(next instanceof Directory)) {
        next = new Directory(new Map());
        dir.set(seg, next);
      }
      dir = (next as Directory).contents;
    }
    dir.set(parts[parts.length - 1]!, new File(data, { readonly: true }));
  }
  const outName = req.options["output-file"];
  const outFile = typeof outName === "string" ? new File(new Uint8Array(), { readonly: false }) : null;
  if (outFile) root.set(outName as string, outFile);

  const json = enc.encode(JSON.stringify(req.options));
  const ptr = ex.malloc(json.length);
  new Uint8Array(ex.memory.buffer).set(json, ptr);
  try {
    ex.convert(ptr, json.length);
  } catch (e) {
    const dec = new TextDecoder();
    return { ok: false, error: String((e as Error)?.message ?? e), stderr: dec.decode(stderr.data) };
  }
  const dec = new TextDecoder();
  const err = dec.decode(stderr.data);
  const output = outFile ? outFile.data : stdout.data;
  return { ok: output.length > 0, output, stdout: outFile ? dec.decode(stdout.data) : undefined, stderr: err, warnings: dec.decode(warnings.data), error: output.length ? undefined : err || "pandoc produced no output" };
}

self.onmessage = async (evt: MessageEvent<PandocRequest>) => {
  let res: PandocResponse;
  try {
    res = await run(evt.data);
  } catch (e) {
    res = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  (self as unknown as Worker).postMessage(res, res.output ? [res.output.buffer as ArrayBuffer] : []);
};
