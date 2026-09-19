// Lists every runtime export of obsidian.d.ts (classes, functions, consts,
// enums — not types) and fails if packages/app/src/obsidian/index.ts does not
// export it. A missing name is a plugin that throws on `require("obsidian").X`.
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const program = ts.createProgram([join(root, "packages/app/src/obsidian/index.ts"), join(root, "node_modules/obsidian/obsidian.d.ts")], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true,
  paths: { "@vault/engine": [join(root, "packages/engine/src/index.ts")] }, baseUrl: root,
});
const checker = program.getTypeChecker();

function runtimeExports(file) {
  const sf = program.getSourceFile(file);
  const sym = checker.getSymbolAtLocation(sf);
  const out = new Set();
  for (const s of checker.getExportsOfModule(sym)) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    if (target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Enum)) out.add(s.getName());
  }
  return out;
}

const expected = runtimeExports(join(root, "node_modules/obsidian/obsidian.d.ts"));
const actual = runtimeExports(join(root, "packages/app/src/obsidian/index.ts"));
const missing = [...expected].filter((n) => !actual.has(n)).sort();
console.log(`obsidian.d.ts runtime exports: ${expected.size}; implemented: ${expected.size - missing.length}`);
if (missing.length) {
  console.log("missing:", missing.join(", "));
  process.exit(1);
}
