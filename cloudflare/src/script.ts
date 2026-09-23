// Where a text comes from. Two implementations: the Worker reads the assets
// binding, the parity tool reads the repository on disk. Same paths either way:
// `horas/Latin/Tempora/Pent17-3.txt`, `horas/Ordinarium/Prima.txt`, …
export interface TextSource {
  read(path: string): Promise<string | null>;
}

/** Case-preserving lookup of `[Section]` bodies in a Divinum Officium data file. */
export interface Section {
  name: string;
  lines: string[];
}

/** Parse a data file into its `[Section]`s, keeping the order and duplicates. */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const match = /^\[(.+?)\]\s*$/.exec(line);
    if (match) {
      current = { name: match[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
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
  kind: "section" | "text" | "ref" | "break" | "note" | "unsupported";
  /** section name, reference name, or the line itself */
  value: string;
  sigil?: "$" | "&";
}

const RUBRIC_TOKEN = /rubrica\s+([^\s)]+)/i;

/** Which rubrics a condition token refers to. 1960 is "196" and "1960". */
export function tokenMatchesVersion(token: string, version: string): boolean {
  const wanted = token.toLowerCase().replace(/^\^/, "");
  const current = version.toLowerCase();
  if (wanted === "196" || wanted === "1960") return /196/.test(current);
  if (wanted === "1955") return /1955|19(6|5)/.test(current);
  if (wanted === "monastic") return /monastic/.test(current);
  if (wanted === "cisterciensis") return /cistercien/.test(current);
  if (wanted === "praedicatorum") return /praedicator/.test(current);
  if (wanted === "altovadensis") return /altovaden/.test(current);
  if (wanted === "1617" || wanted === "1930" || wanted === "1951") return current.includes(wanted);
  return false;
}

function parse(script: string, version: string): ScriptItem[] {
  const items: ScriptItem[] = [];
  const lines = script.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\s+$/, "");
    const trimmed = line.trim();

    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      items.push({ kind: "section", value: trimmed.slice(1).trim() });
      continue;
    }
    if (trimmed === "_") {
      items.push({ kind: "break", value: "" });
      continue;
    }
    if (trimmed.startsWith("(") || trimmed.startsWith("[")) {
      // A note that governs what follows. `omittuntur` drops the block for
      // rubrics it names; everything else leaves the block in place.
      const token = RUBRIC_TOKEN.exec(trimmed)?.[1] ?? "";
      const drops = /omittitur|omittuntur/i.test(trimmed) && tokenMatchesVersion(token, version);
      items.push({ kind: "note", value: trimmed });
      if (!drops) continue;
      // Skip the governed block: the following lines until a blank line or a
      // section marker.
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = lines[cursor];
        if (next.trim() === "" || next.trim().startsWith("#")) break;
        cursor++;
      }
      index = cursor - 1;
      continue;
    }
    const ref = /^([$&])(.+)$/.exec(trimmed);
    if (ref) {
      items.push({ kind: "ref", value: ref[2].trim(), sigil: ref[1] as "$" | "&" });
      continue;
    }
    if (trimmed.startsWith("$rubrica")) {
      items.push({ kind: "unsupported", value: trimmed });
      continue;
    }
    items.push({ kind: "text", value: trimmed });
  }
  return items;
}

export function parseScript(script: string, version: string, hour: string): ScriptItem[] {
  return parse(hour === "Vesperae" ? script.replace(/Vesperae/g, "Vespera") : script, version);
}

/** The sections a script declares, in order — the shape of the rendered hour. */
export function scriptSections(items: ScriptItem[]): string[] {
  return items.filter((item) => item.kind === "section").map((item) => item.value);
}
