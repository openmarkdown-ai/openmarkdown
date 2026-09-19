import "@vault/app/styles/index.css";
import { boot } from "@vault/app/boot";

// Served at https://openmarkdown.ai/app/, beside the landing page at `/`, the
// brand mark links there; a copy served at a site's root has no landing page.
const underApp = /\/app\/$/.test(new URL("./", document.baseURI).pathname);

void boot({
  root: document.body,
  serviceWorkerUrl: new URL("./sw.js", document.baseURI).toString(),
  chrome: {
    accountUrl: new URL("./account", document.baseURI).toString(),
    homeUrl: underApp ? new URL("../", document.baseURI).pathname : null,
    brandIconUrl: new URL("./favicon.svg", document.baseURI).toString(),
  },
});
