// "Ask Claude" without React: reading the server's event stream, and turning an answer's light
// markdown into blocks the panel renders as elements (never as HTML), with each ```suggestion
// block parsed so the panel can offer to save it as an idea.

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Split complete server-sent events off the front of `buffer`; the rest waits for more bytes. */
export function parseSse(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const frames = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    } catch {
      /* a frame that isn't JSON is skipped */
    }
  }
  return { events, rest };
}

export interface Suggestion {
  in: string;
  out: string | null;
  why: string | null;
}

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "suggestion"; suggestion: Suggestion; raw: string };

/** The fields of a ```suggestion block, or null when it has no card to put in. */
export function parseSuggestion(body: string): Suggestion | null {
  const field = (name: string) => {
    const m = body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
    const v = m?.[1]?.trim() ?? "";
    return v && !/^(none|n\/a|-|blank)$/i.test(v) ? v : null;
  };
  const inn = field("in");
  if (!inn) return null;
  return { in: inn.slice(0, 200), out: field("out")?.slice(0, 200) ?? null, why: field("why")?.slice(0, 2000) ?? null };
}

/** Blocks of an answer, as far as it has arrived (an unclosed code fence is shown as code). */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1]?.toLowerCase() ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const raw = body.join("\n");
      const s = lang === "suggestion" ? parseSuggestion(raw) : null;
      blocks.push(s ? { kind: "suggestion", suggestion: s, raw } : { kind: "code", text: raw });
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
    } else if (bullet || numbered) {
      const ordered = !!numbered;
      if (para.length) {
        blocks.push({ kind: "p", text: para.join(" ") });
        para = [];
      }
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!.trim());
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export type Segment = { text: string; bold?: boolean; code?: boolean };

/** **bold** and `code` inside a line; everything else is plain text. */
export function inline(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] != null) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2]!, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export type ContextKind = "general" | "plan_deck" | "review" | "deck" | "precon" | "experiment";

/** Starter questions for each context, shown in an empty panel. */
export function starters(kind: ContextKind): string[] {
  switch (kind) {
    case "plan_deck":
      return ["Which of the proposed swaps would you take first, and why?", "What is this deck still missing?", "Do the lab results say anything I can trust about these changes?"];
    case "review":
      return ["Which proposals should I say yes to first?", "Are any of these proposals redundant with each other?"];
    case "deck":
      return ["What are this deck's weakest cards?", "How could I make it faster without raising its bracket?"];
    case "precon":
      return ["What are the first five upgrades you'd make to this precon?", "How does this precon usually win?"];
    case "experiment":
      return ["What does this result actually tell me?", "How many more games would I need to be sure?"];
    default:
      return ["Which of my decks needs the most work?", "What should I buy next?"];
  }
}

/** Why the advisor isn't available, in a sentence, from the status's reason. */
export function unavailableText(reason: string | null | undefined, canSaveKey: boolean): string {
  switch (reason) {
    case "needs_key":
      return canSaveKey
        ? "To ask Claude, add your own Anthropic API key in Settings. Questions are billed to your Anthropic account."
        : "Ask Claude isn't available to your account on this server.";
    case "keys_off":
      return "Ask Claude is only available to this server's owner.";
    default:
      return "Ask Claude isn't set up on this server.";
  }
}
