// Vite asset queries used by the slides and citations core plugins.
declare module "reveal.js/*?inline" {
  const css: string;
  export default css;
}
declare module "reveal.js?raw" {
  const source: string;
  export default source;
}
declare module "*.csl?raw" {
  const xml: string;
  export default xml;
}
declare module "*.xml?raw" {
  const xml: string;
  export default xml;
}
