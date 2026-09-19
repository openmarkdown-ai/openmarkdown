/**
 * `Editor` — the abstract editor interface from obsidian.d.ts.
 *
 * The runtime `obsidian` module re-exports this class, so a plugin's
 * `editor instanceof Editor` holds for the CM6 implementation in editor.ts.
 * The concrete (non-abstract) members are the ones the d.ts declares with a
 * body: they are defined here in terms of the abstract ones, exactly so a
 * plugin subclassing `Editor` gets them for free.
 *
 * Positions are 0-based `line` and UTF-16 `ch`.
 */
import type {
  EditorChange,
  EditorCommandName,
  EditorPosition,
  EditorRange,
  EditorSelection,
  EditorSelectionOrCaret,
  EditorTransaction,
} from "obsidian";

export type {
  EditorChange,
  EditorCommandName,
  EditorPosition,
  EditorRange,
  EditorRangeOrCaret,
  EditorScrollInfo,
  EditorSelection,
  EditorSelectionOrCaret,
  EditorTransaction,
} from "obsidian";

export abstract class Editor {
  getDoc(): this {
    return this;
  }
  abstract refresh(): void;
  abstract getValue(): string;
  abstract setValue(content: string): void;
  abstract getLine(line: number): string;
  setLine(n: number, text: string): void {
    this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: this.getLine(n).length });
  }
  abstract lineCount(): number;
  abstract lastLine(): number;
  abstract getSelection(): string;
  somethingSelected(): boolean {
    return this.getSelection().length > 0;
  }
  abstract getRange(from: EditorPosition, to: EditorPosition): string;
  abstract replaceSelection(replacement: string, origin?: string): void;
  abstract replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
  abstract getCursor(side?: "from" | "to" | "head" | "anchor"): EditorPosition;
  abstract listSelections(): EditorSelection[];
  setCursor(pos: EditorPosition | number, ch?: number): void {
    const p = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
    this.setSelection(p, p);
  }
  abstract setSelection(anchor: EditorPosition, head?: EditorPosition): void;
  abstract setSelections(ranges: EditorSelectionOrCaret[], main?: number): void;
  abstract focus(): void;
  abstract blur(): void;
  abstract hasFocus(): boolean;
  abstract getScrollInfo(): { top: number; left: number };
  abstract scrollTo(x?: number | null, y?: number | null): void;
  abstract scrollIntoView(range: EditorRange, center?: boolean): void;
  abstract undo(): void;
  abstract redo(): void;
  abstract exec(command: EditorCommandName): void;
  abstract transaction(tx: EditorTransaction, origin?: string): void;
  abstract wordAt(pos: EditorPosition): EditorRange | null;
  abstract posToOffset(pos: EditorPosition): number;
  abstract offsetToPos(offset: number): EditorPosition;

  /**
   * Read every selected line (or every line of every selection), then apply
   * the `write` results as one transaction. Lines are visited once even when
   * several selections touch them. With `ignoreEmpty`, a selection that ends
   * at ch 0 of a line does not include that line.
   */
  processLines<T>(
    read: (line: number, lineText: string) => T | null,
    write: (line: number, lineText: string, value: T | null) => EditorChange | void,
    ignoreEmpty = false,
  ): void {
    const lines = new Set<number>();
    for (const sel of this.listSelections()) {
      let from = sel.anchor, to = sel.head;
      if (from.line > to.line || (from.line === to.line && from.ch > to.ch)) [from, to] = [to, from];
      let end = to.line;
      if (ignoreEmpty && end > from.line && to.ch === 0) end--;
      for (let l = from.line; l <= end; l++) lines.add(l);
    }
    const ordered = [...lines].sort((a, b) => a - b);
    const values = ordered.map((l) => read(l, this.getLine(l)));
    const changes: EditorChange[] = [];
    ordered.forEach((l, i) => {
      const change = write(l, this.getLine(l), values[i] ?? null);
      if (change) changes.push(change);
    });
    if (changes.length) this.transaction({ changes });
  }
}
