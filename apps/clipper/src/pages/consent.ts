/** Per-origin consent for the network bridge, opened by the background on an origin's first request. */
import type { RuntimeMessage } from "../shared/messages";
import { brandMark, button, h } from "./dom";
import "./ui.css";
import "./consent.css";

const origin = new URLSearchParams(location.search).get("origin") ?? "";
const answer = async (granted: boolean) => {
  const msg: RuntimeMessage = { kind: "consent-answer", origin, granted };
  await chrome.runtime.sendMessage(msg);
  window.close();
};

document.getElementById("app")!.append(
  h(
    "main",
    { class: "consent" },
    brandMark(),
    h("p", { class: "eyebrow", text: "Network bridge" }),
    h("h1", { text: "Allow this app to make network requests?" }),
    h("p", { class: "origin mono", id: "consent-origin", text: origin }),
    h("p", { class: "lede", text: "Pages at this address could then read any website through the extension, as plugins in the desktop app can. Cookies and saved logins are never sent." }),
    h("div", { class: "consent-actions" }, button("Don't allow", () => void answer(false), "secondary"), button("Allow", () => void answer(true), "primary")),
  ),
);
