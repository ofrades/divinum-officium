// Where a text comes from. Two implementations: the Worker reads the assets
// binding, the parity tool reads the repository on disk. Same paths either way:
// `horas/Latin/Tempora/Pent17-3.txt`, `horas/Ordinarium/Prima.txt`, …
export interface TextSource {
  read(path: string): Promise<string | null>;
}

import { processConditionalLines, vero, type ConditionContext } from "./conditional";

/** Case-preserving lookup of `[Section]` bodies in a Divinum Officium data file. */
export interface Section {
  name: string;
  lines: string[];
}

/** Parse a data file into its `[Section]`s, keeping the order and duplicates. */
export function parseSections(text: string, context?: ConditionContext): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let skipping = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    // A section header may carry its own condition: `[Oratio] (rubrica 1960)`.
    const match = /^\s*\[([^\]]+)\]\s*(?:\(([^)]*)\))?\s*$/.exec(line);
    if (match) {
      const condition = match[2] ?? "";
      skipping = context !== undefined && condition !== "" && !vero(condition, context);
      current = skipping ? null : { name: match[1], lines: [] };
      if (current) sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  // A section's *body* carries conditions too, and the engine resolves them
  // when it loads the file (`setupstring_parse_file`). Without this, lines like
  // "(sed rubrica Ordo Praedicatorum dicitur)" would be printed as text.
  if (context) {
    for (const section of sections) section.lines = processConditionalLines(section.lines, context);
  }
  return sections;
}

/** The first `[name]` body in a file, trimmed of leading and trailing blanks. */
export function sectionBody(sections: Section[], name: string): string[] | null {
  const found = sections.find((section) => section.name === name);
  if (!found) return null;
  const lines = [...found.lines];
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/**
 * The Ordinarium is a script: `#Section` markers, `$Name` / `&Name` references,
 * plain text, `_` (a break that keeps a line with the next) and `(condition)`
 * notes that apply to the lines around them.
 *
 * The engine's own conditional processor is a small language in itself
 * (scopes: line / chunk / nest, with strengths and offsets). This port covers
 * the cases the Ordinarium actually uses for the hours implemented so far:
 * a note on its own line governs the block that follows it, up to a blank line
 * or the next section — `omittuntur` drops that block for the matching
 * rubrics, `dicuntur` keeps it. Anything more exotic is reported, not guessed.
 */
export interface ScriptItem {
  kind: "section" | "text" | "ref" | "break" | "rubricNote";
  /** section name, reference name, or the line itself */
  value: string;
  sigil?: "$" | "&";
}

/**
 * The Ordinarium script, tokenised. Conditions are resolved first by the
 * engine's own processor (src/conditional.ts), so what is left is structure:
 * `#Sections`, `$` / `&` references, `$rubrica` notes, plain text and `_`.
 */
function tokenise(lines: string[]): ScriptItem[] {
  const items: ScriptItem[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      items.push({ kind: "section", value: line.slice(1).trim() });
      continue;
    }
    if (line === "_") {
      items.push({ kind: "break", value: "" });
      continue;
    }
    if (/^\$rubrica\b/i.test(line)) {
      items.push({ kind: "rubricNote", value: line.replace(/^\$rubrica\s*/i, "").trim() });
      continue;
    }
    const ref = /^([$&])(.+)$/.exec(line);
    if (ref) {
      items.push({ kind: "ref", value: ref[2].trim(), sigil: ref[1] as "$" | "&" });
      continue;
    }
    items.push({ kind: "text", value: line });
  }
  return items;
}

export function parseScript(script: string, context: ConditionContext): ScriptItem[] {
  const hour = context.hour === "Vesperae" ? "Vespera" : context.hour;
  return tokenise(processConditionalLines(script.split(/\r?\n/), { ...context, hour }));
}

/**
 * The sections a script renders, in order.
 *
 * A section with no content is not rendered at all: the Ordinarium declares
 * `#Preces Feriales` and then suppresses its lines for most rubrics, and the
 * engine prints nothing — no label, no empty block. That is why this looks at
 * what a section actually holds rather than at its markers.
 */
export interface ScriptBlock {
  label: string;
  hasContent: boolean;
  items: ScriptItem[];
}

/** The script's blocks: a section marker with the items that follow it. */
export function scriptBlocks(items: ScriptItem[]): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let current: ScriptBlock | null = null;
  for (const item of items) {
    if (item.kind === "section") {
      current = { label: item.value, hasContent: false, items: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    current.items.push(item);
    if (item.kind === "ref" || item.kind === "text" || item.kind === "rubricNote") current.hasContent = true;
  }
  return blocks;
}

export interface ScriptSection {
  label: string;
  /** Whether anything in the script fills this section. */
  hasContent: boolean;
}

/**
 * The sections a script declares, in order, and whether each has content.
 *
 * `hasContent` matters because the two kinds of empty section are not alike:
 * `#Hymnus` and `#Psalmi` are filled by convention from the day's file and the
 * psalterium, while `#Preces Feriales` is filled from tables only when the day
 * calls for it. The caller decides what to do with each.
 */
export function scriptSections(items: ScriptItem[]): ScriptSection[] {
  const sections: ScriptSection[] = [];
  let current: ScriptSection | null = null;
  for (const item of items) {
    if (item.kind === "section") {
      current = { label: item.value, hasContent: false };
      sections.push(current);
      continue;
    }
    if (current !== null && (item.kind === "ref" || item.kind === "text" || item.kind === "rubricNote")) {
      current.hasContent = true;
    }
  }
  return sections;
}

