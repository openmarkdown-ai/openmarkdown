/**
 * The Markdown language the editor installs.
 *
 * Two trees exist per parse:
 *  - the structural tree: CommonMark + OFM extensions on @lezer/markdown, with
 *    fenced code highlighted by lazily loaded @codemirror/language-data
 *    grammars. The editor's own extensions use it (via `ofmTree`).
 *  - the HyperMD token tree `syntaxTree(state)` returns, shaped like
 *    Obsidian's so community plugins that inspect node names keep working
 *    (see hypermd-language.ts).
 */
import { markdown, commonmarkLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { ofmExtensions } from "./ofm";
import { hypermdLanguage, structuralTreeProp } from "./hypermd-language";

/** Obsidian accepts a few names language-data does not know. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  ps1: "powershell",
  dataviewjs: "javascript",
};

export function findCodeLanguage(info: string): LanguageDescription | null {
  const name = (/^\S*/.exec(info.trim())?.[0] ?? "").toLowerCase();
  if (!name) return null;
  return (
    LanguageDescription.matchLanguageName(languages, name, true) ??
    (LANGUAGE_ALIASES[name] ? LanguageDescription.matchLanguageName(languages, LANGUAGE_ALIASES[name]!, true) : null)
  );
}

let structural: Language | null = null;
let installed: Language | null = null;

/** The structural OFM language (not installed in editors; exposed for tools and tests). */
export function ofmStructuralLanguage(): Language {
  if (!structural) {
    structural = markdown({
      base: commonmarkLanguage,
      codeLanguages: (info) => findCodeLanguage(info),
      extensions: ofmExtensions,
      addKeymap: false,
      completeHTMLTags: false,
      pasteURLAsLink: false,
    }).language;
  }
  return structural;
}

/** The language installed in editors: HyperMD token tree outside, structural tree inside. */
export function ofmLanguage(): Language {
  if (!installed) installed = hypermdLanguage(ofmStructuralLanguage());
  return installed;
}

/** The structural OFM tree for a state (what the editor's extensions walk). */
export function ofmTree(state: EditorState): Tree {
  const outer = syntaxTree(state);
  return outer.prop(structuralTreeProp) ?? outer;
}

/** Like `ensureSyntaxTree`, returning the structural tree. */
export function ensureOfmTree(state: EditorState, upto: number, timeout = 50): Tree | null {
  const outer = ensureSyntaxTree(state, upto, timeout);
  return outer ? (outer.prop(structuralTreeProp) ?? outer) : null;
}

export { structuralTreeProp };
