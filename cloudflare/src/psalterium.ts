import type { OfficeLine } from "./office";
import { renderBody, renderLine, type RenderContext } from "./render";
import { parseSections, sectionBody, type TextSource } from "./script";
import { processConditionalLines, type ConditionContext } from "./conditional";

// The psalmody: which psalms a little hour says on a given weekday, the text of
// each psalm, and the doxology that closes it.
//
// `Psalterium/Psalmi/Psalmi minor.txt` holds a section per hour, and inside it a
// line per weekday giving the antiphon and the psalm list:
//
//   [Prima]
//   Feria IV = Misericórdia tua, * Dómine, ante óculos meos: …
//   25,51,52,[96]
//
// A psalm spec may carry a verse range (`18(2-'7b')`) and may be bracketed
// (`[96]`) — bracketed psalms are not said on the day, as the corpus confirms
// for Prime on a Wednesday (three rows, not four).

export interface PsalmSpec {
  number: number;
  from?: { verse: number; sub?: string };
  to?: { verse: number; sub?: string };
}

export interface PsalmPlan {
  antiphon: string;
  psalms: PsalmSpec[];
}

const WEEKDAY_NAMES = ["Dominica", "Feria II", "Feria III", "Feria IV", "Feria V", "Feria VI", "Sabbato"];

/** The `Psalmi minor.txt` hour section's plan for a weekday. */
export function parsePlan(text: string, hour: string, weekday: number): PsalmPlan | null {
  const section = sectionBody(parseSections(text), hour === "Prima" ? "Prima" : hour);
  if (!section) return null;

  for (let index = 0; index < section.length; index++) {
    const line = section[index].trim();
    const named = /^(Dominica|Feria [IV]+|Sabbato)\s*=\s*(.*)$/.exec(line);
    if (named && named[1] === WEEKDAY_NAMES[weekday]) {
      const antiphon = named[2].trim();
      const next = (section[index + 1] ?? "").trim();
      return { antiphon, psalms: parseSpecs(next) };
    }
  }
  return null;
}

export function parseSpecs(line: string): PsalmSpec[] {
  const specs: PsalmSpec[] = [];
  for (const token of line.split(",")) {
    const spec = token.trim();
    if (spec === "" || spec.startsWith("[")) continue; // bracketed: not said
    const match = /^(\d+)(?:\(\s*(\d+)([a-z]?)\s*[-–]\s*'?(\d+)([a-z]?)'?\s*\))?$/.exec(spec);
    if (!match) continue;
    specs.push({
      number: parseInt(match[1], 10),
      from: match[2] ? { verse: parseInt(match[2], 10), sub: match[3] || undefined } : undefined,
      to: match[4] ? { verse: parseInt(match[4], 10), sub: match[5] || undefined } : undefined,
    });
  }
  return specs;
}

/** One psalm's verses, from `Psalterium/Psalmorum/PsalmNN.txt`. */
export async function psalmVerses(
  source: TextSource,
  lang: string,
  spec: PsalmSpec,
  context: ConditionContext,
): Promise<string[] | null> {
  const paths = [
    `horas/${lang}/Psalterium/Psalmorum/Psalm${spec.number}.txt`,
    `horas/Latin/Psalterium/Psalmorum/Psalm${spec.number}.txt`,
  ];
  for (const path of paths) {
    const text = await source.read(path);
    if (text === null) continue;
    // A psalm file has no section headers: its verses are the file itself.
    const lines = processConditionalLines(text.split(/\r?\n/), context)
      .map((line) => line.trim())
      .filter((line) => /^\d+\s*[:.]\s*\d+/.test(line));
    return lines.filter((line) => inRange(line, spec));
  }
  return null;
}

/** Whether a verse line falls inside the spec's range (`18(2-'7b')`). */
function inRange(line: string, spec: PsalmSpec): boolean {
  const match = /^(\d+)\s*[:.]\s*(\d+)\s*([a-z]?)/.exec(line);
  if (!match) return false;
  const verse = parseInt(match[2], 10);
  const sub = match[3] ?? "";
  if (spec.from) {
    if (verse < spec.from.verse) return false;
    // The psalm's verse numbering runs across the parts, so the from-point is
    // where a numbered verse begins: sub-verse letters only matter when the
    // range starts mid-verse, which the data expresses as the same number.
  }
  if (spec.to) {
    if (verse > spec.to.verse) return false;
  }
  void sub;
  return true;
}

/** The doxology that closes a psalm: the rule's, or the ordinary Gloria. */
export async function doxology(
  source: TextSource,
  lang: string,
  rule: string,
  context: ConditionContext,
  render: RenderContext,
): Promise<OfficeLine[]> {
  const named = /Doxology\s*=\s*(\w+)/i.exec(rule);
  if (named) {
    for (const path of [
      `horas/${lang}/Psalterium/Doxologies.txt`,
      "horas/Latin/Psalterium/Doxologies.txt",
    ]) {
      const text = await source.read(path);
      if (text === null) continue;
      const body = sectionBody(parseSections(text, context), named[1]);
      if (body) return renderBody(body, render);
    }
  }
  // The ordinary `Gloria Patri` / `Sicut erat` pair.
  for (const path of [
    `horas/${lang}/Psalterium/Common/Prayers.txt`,
    "horas/Latin/Psalterium/Common/Prayers.txt",
  ]) {
    const text = await source.read(path);
    if (text === null) continue;
    const body = sectionBody(parseSections(text, context), "Gloria");
    if (body) return renderBody(body, render);
  }
  return [];
}

/**
 * The psalmody as the reader shows it: one row per psalm, the antiphon opening
 * the first and closing the last (with the mediant dropped, as the engine
 * prints the repetition).
 */
export async function psalmodyRows(
  source: TextSource,
  lang: string,
  hour: string,
  dayKey: string,
  weekday: number,
  rule: string,
  context: ConditionContext,
  render: RenderContext,
): Promise<OfficeLine[][] | null> {
  const minor = hour === "Prima" || hour === "Tertia" || hour === "Sexta" || hour === "Nona";
  if (!minor) return null;

  const text = await source.read(`horas/${lang}/Psalterium/Psalmi/Psalmi minor.txt`)
    ?? await source.read("horas/Latin/Psalterium/Psalmi/Psalmi minor.txt");
  if (text === null) return null;

  const plan = parsePlan(text, hour, weekday);
  if (!plan || plan.psalms.length === 0) return null;

  const close = await doxology(source, lang, rule, context, render);
  const rows: OfficeLine[][] = [];

  for (const [index, spec] of plan.psalms.entries()) {
    const lines: OfficeLine[] = [];
    if (index === 0) {
      const antiphon = renderLine(`Ant. ${plan.antiphon}`, render);
      if (antiphon) lines.push(antiphon);
    }
    const title = `Psalmus ${spec.number}`;
    lines.push({ k: "title", text: title, after: `[${index + 1}]` });
    const verses = await psalmVerses(source, lang, spec, context);
    if (verses) lines.push(...renderBody(verses, render));
    lines.push(...close);
    rows.push(lines);
  }

  // The antiphon returns at the end of the last row, without its mediant.
  const last = rows[rows.length - 1];
  const repeated = plan.antiphon.replace(/\s*\*\s*/, " ").trim();
  const antiphon = renderLine(`Ant. ${repeated}`, render);
  if (antiphon) {
    last.push(antiphon);
    // The engine prints the repetition as plain text, not as a rubric.
    last[last.length - 1] = { k: "rubric", marker: "Ant.", text: repeated };
  }
  void dayKey;
  return rows;
}
