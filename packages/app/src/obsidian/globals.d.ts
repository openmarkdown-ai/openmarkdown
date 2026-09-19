// Brings obsidian.d.ts's `declare global` block (createDiv, Array.contains,
// activeDocument …) into scope for the app's own code. The implementations are
// installed at runtime by dom.ts.
import type {} from "obsidian";
