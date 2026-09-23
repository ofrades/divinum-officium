import type { OfficeLine } from "./office";

// Turning the engine's text into the reader's lines.
//
// The data files carry their own notation — versicle markers, the cross, the
// mediant star, versification — and the website renders it into HTML that the
// reader then classifies. This does the same job directly: notation in, marked
// lines out, with the same classifications the reader's parser produces
// (`rubric`, `title`, `verse`, `text`), so the JSON matches.

export interface RenderContext {
  /** The rubrical version, which decides the Latin orthography. */
  version: string;
}

/**
 * The 1960 orthography writes the consonant `j` as `i` — `adjutórium` becomes
 * `adiutórium`, `Jesu` becomes `Iesu`, `Allelúja` becomes `Allelúia` — while the
 * older editions keep the `j`. The engine applies this somewhere the corpus can
 * see but the source I could find does not spell out, so it is written here
 * explicitly, gated on the version, and the corpus judges it.
 */
export function orthography(text: string, version: string): string {
  return /19(5[5-9]|6\d)/.test(version) ? text.replace(/j/g, "i").replace(/J/g, "I") : text;
}

/** The engine's fancy characters: `+` is the cross, `++`/`+++` its variants. */
export function fancy(text: string): string {
  return text
    .replace(/\+\+\+/g, "✙︎")
    .replace(/\+\+/g, "✠✠")
    .replace(/\+/g, "✠");
}

const VERSE_NUMBER = /^([0-9]+[:.]\s*[0-9]+)\s+(.*)$/;
const PSALM_TITLE = /^(Psalmus|Psalm|Canticum|Canticle)\s+((?:[0-9]+|[\p{Lu}][\p{Ll}]+).*)$/u;
const MARKERS = /^(℣\.|℟\.|V\.|R\.|Ant\.|v\.|r\.)\s*(.*)$/;

/**
 * One source line to one classified line, or null when the line is notation
 * rather than text (a lowercase `v.`/`r.` marker, an empty line).
 */
export function renderLine(raw: string, context: RenderContext): OfficeLine | null {
  let line = orthography(raw.trim(), context.version);
  if (line === "") return null;

  // The mediant star and the flexa are kept as they stand: they are how the
  // psalm is pointed, and the reader shows them.
  const marker = MARKERS.exec(line);
  if (marker) {
    const [, token, rest] = marker;
    // Capital V./R. are the versicle and response; their lowercase forms are a
    // voicing mark, and the engine prints them as plain text.
    if (token === "V." || token === "R.") {
      return { k: "rubric", marker: token === "V." ? "℣." : "℟.", text: fancy(rest) };
    }
    if (token.toUpperCase() === "ANT.") {
      return { k: "rubric", marker: "Ant.", text: fancy(rest) };
    }
    line = rest;
  }

  const title = PSALM_TITLE.exec(line);
  if (title) {
    const after = /\s*(\[[^\]]*\])$/.exec(title[2]);
    const text = after ? title[2].slice(0, after.index).trim() : title[2];
    return { k: "title", text: `${title[1]} ${text}`, ...(after ? { after: after[1] } : {}) };
  }

  const verse = VERSE_NUMBER.exec(line);
  if (verse) return { k: "verse", marker: verse[1], text: fancy(verse[2]) };

  return { k: "text", text: fancy(line) };
}

/**
 * A section body's lines, classified, blanks dropped.
 *
 * `firstOnly` is for the Incipit's Alleluia: `[Alleluia]` carries a second line
 * ("Laus tibi, Dómine, Rex ætérnæ glóriæ") that the engine does not print in the
 * hours served so far — it belongs to a tone the engine picks by hour and
 * season through a script function. Until that selection is ported, an
 * Alleluia reference takes its first line only; the corpus says so for every
 * day of the year here.
 */
export function renderBody(lines: string[], context: RenderContext, firstOnly = false): OfficeLine[] {
  const out: OfficeLine[] = [];
  for (const line of lines) {
    const rendered = renderLine(line, context);
    if (rendered) {
      out.push(rendered);
      if (firstOnly) break;
    }
  }
  return out;
}
