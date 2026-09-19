/**
 * Retrieval-augmented prompts for Chat with vault: how many passages fit the
 * engine's context window, how they are labelled, and how the answer's
 * citations become links to real notes.
 */
import type { AiMessage, EngineInfo } from "../../ai/types";

export interface Source {
  /** 1-based number shown to the model and the user. */
  n: number;
  path: string;
  headings: string[];
  startLine: number;
  endLine: number;
  /** `Note#Heading` (no brackets), as it should appear in a citation. */
  linktext: string;
  text: string;
  score: number;
}

export interface Turn {
  question: string;
  answer: string;
}

/** Rough characters per token for budgeting (English prose ≈ 4; kept low to be safe for other scripts). */
const CHARS_PER_TOKEN = 3;

/** Context window assumed when the engine does not say: small on device, generous elsewhere. */
export function contextWindowOf(engine: EngineInfo | null): number {
  if (engine?.contextWindow && engine.contextWindow > 0) return engine.contextWindow;
  if (!engine || engine.location === "device") return 4096;
  if (engine.location === "local-server") return 8192;
  return 64000;
}

export interface Budget {
  /** Characters of passages to include. */
  contextChars: number;
  /** Characters of earlier turns to include. */
  historyChars: number;
  maxPassages: number;
  maxAnswerTokens: number;
}

export function budgetFor(engine: EngineInfo | null): Budget {
  const window = contextWindowOf(engine);
  const maxAnswerTokens = Math.min(1500, Math.max(256, Math.floor(window / 5)));
  const promptTokens = window - maxAnswerTokens - 350;
  // Cloud windows are huge; more than ~12 passages rarely helps and costs money.
  const chars = Math.max(1200, Math.min(24_000, promptTokens * CHARS_PER_TOKEN));
  return {
    contextChars: Math.floor(chars * 0.8),
    historyChars: Math.floor(chars * 0.2),
    maxPassages: window <= 4096 ? 4 : window <= 8192 ? 8 : 12,
    maxAnswerTokens,
  };
}

/** Takes passages in rank order until the budget is spent; long passages are cut rather than skipped when nothing fits yet. */
export function fitSources<T extends { text: string }>(ranked: T[], budget: Budget): T[] {
  const out: T[] = [];
  let used = 0;
  for (const s of ranked) {
    if (out.length >= budget.maxPassages) break;
    const cost = s.text.length + 60;
    if (used + cost > budget.contextChars) {
      if (!out.length) out.push({ ...s, text: s.text.slice(0, Math.max(200, budget.contextChars - 60)) });
      if (out.length) break;
    }
    out.push(s);
    used += cost;
  }
  return out;
}

export const SYSTEM_PROMPT = [
  "You answer questions using passages from the user's notes.",
  "Use only the passages. If they do not contain the answer, say that the notes don't cover it.",
  "After each statement that uses a passage, cite it with the passage's link exactly as given, for example [[Project plan#Budget]].",
  "Answer in the language of the question, concisely, in Markdown.",
].join(" ");

export function buildMessages(question: string, sources: Source[], history: Turn[], budget: Budget): AiMessage[] {
  const messages: AiMessage[] = [];
  let left = budget.historyChars;
  const kept: Turn[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]!;
    const cost = t.question.length + t.answer.length;
    if (cost > left) break;
    kept.unshift(t);
    left -= cost;
  }
  for (const t of kept) {
    messages.push({ role: "user", content: t.question });
    messages.push({ role: "assistant", content: t.answer });
  }
  const passages = sources.length
    ? sources.map((s) => `Passage ${s.n} — link: [[${s.linktext}]]\n${s.text.trim()}`).join("\n\n---\n\n")
    : "(No passages were found.)";
  messages.push({ role: "user", content: `PASSAGES FROM MY NOTES\n\n${passages}\n\nQUESTION\n${question}` });
  return messages;
}

/**
 * Makes citations point at real notes: `[n]` / `[Passage n]` become the passage's link,
 * and `[[links]]` that resolve to no note are left as plain text (a model must not invent notes).
 */
export function linkCitations(answer: string, sources: Source[], resolves: (linktext: string) => boolean): string {
  const byN = new Map(sources.map((s) => [s.n, s]));
  let text = answer.replace(/\[(?:Passage\s+)?(\d{1,2})\](?!\(|\])/gi, (m, d: string) => {
    const s = byN.get(Number(d));
    return s ? `[[${s.linktext}]]` : m;
  });
  text = text.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (m, bang: string, inner: string) => {
    if (bang) return m;
    const target = inner.split("|")[0]!;
    if (resolves(target)) return m;
    // A heading the model reworded: keep the link to the note when the note exists.
    const note = target.split("#")[0]!;
    if (note && resolves(note)) return `[[${note}${inner.includes("|") ? "|" + inner.split("|").slice(1).join("|") : ""}]]`;
    return inner.split("|").pop()!;
  });
  return text;
}

/** Links cited in an answer, in order, without duplicates. */
export function citedLinks(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/(?<!!)\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** "Chat with vault" conversation as a note. */
export function conversationMarkdown(turns: (Turn & { sources: Source[]; engine: string })[], created: string): string {
  const lines: string[] = ["---", `created: ${created}`, "tags:", "  - ai-chat", "---", ""];
  const first = turns[0]?.question.split("\n")[0]?.slice(0, 80) ?? "Chat";
  lines.push(`# ${first}`, "");
  for (const t of turns) {
    lines.push("> [!question] You");
    for (const l of t.question.split("\n")) lines.push(`> ${l}`);
    lines.push("", t.answer.trim(), "");
    const cited = t.sources.map((s) => `[[${s.linktext}]]`);
    if (cited.length) lines.push(`Sources: ${cited.join(" · ")}`);
    if (t.engine) lines.push(`*${t.engine}*`);
    lines.push("");
  }
  return lines.join("\n");
}
