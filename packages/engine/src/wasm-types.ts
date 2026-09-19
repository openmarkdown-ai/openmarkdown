// Shape of the wasm-bindgen glue in ./wasm-gen. Kept loose on purpose: bind.ts
// is the one place that knows the individual export names.
export type WasmExports = Record<string, any>;
