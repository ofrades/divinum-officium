import type { OfficeLine } from "./office";
import { renderBody, renderLine, type RenderContext } from "./render";
import { parseSections, sectionBody, type TextSource } from "./script";
import { resolveSection } from "./texts";
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

/**
 * Which pair of lines in the hour's section holds the day's psalmody.
 *
 * The engine's own selection (specials/psalmi.pl): the weekday pair by default,
 * the Sunday pair when the rule says `Psalmi Dominica`, and the weekday pair
 * again under the 1960 rubrics for the days whose rank lets them keep the
 * ferial psalms — which is most feasts.
 */
export function planIndex(hour: string, weekday: number, selection: DaySelection, version: string): number {
  const rule = selection.rule ?? "";
  const winner = selection.winner ?? "";
  const rank = parseFloat(selection.rank ?? "") || 0;
  const titles = selection.titles ?? [];

  let index = 2 * weekday;
  if (/Psalmi\s*(?:minores)?\s*Dominica/i.test(rule)) index = 0;
  if (
    /19(?:55|60|62)/.test(version) &&
    (/horas1960 feria/i.test(rule) ||
      (/Sancti|C[1-7]/i.test(winner) && rank < 5) ||
      (/Sancti|C[1-7]/i.test(winner) || /Nat[23]/i.test(winner)) && rank < 6 && hour !== "Completorium")
  ) {
    index = 2 * weekday;
  }
  if (
    hour === "Completorium" &&
    weekday === 6 &&
    /Dominica/i.test(titles[1] ?? "") &&
    !/^Nat/.test(titles[0] ?? "")
  ) {
    index = 12;
  }
  return index;
}

/** The `Psalmi minor.txt` hour section's plan at the chosen pair of lines. */
export function parsePlan(text: string, hour: string, index: number): PsalmPlan | null {
  const section = sectionBody(parseSections(text), hour === "Prima" ? "Prima" : hour);
  if (!section || index + 1 >= section.length) return null;

  const antiphon = section[index].trim().replace(/^[^=]*=\s*/, "");
  const psalms = section[index + 1].trim();
  if (antiphon === "" || psalms === "") return null;
  return { antiphon, psalms: parseSpecs(psalms) };
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
  selection?: DaySelection,
  version?: string,
): Promise<OfficeLine[][] | null> {
  const minor = hour === "Prima" || hour === "Tertia" || hour === "Sexta" || hour === "Nona";
  if (!minor) return null;

  const text = await source.read(`horas/${lang}/Psalterium/Psalmi/Psalmi minor.txt`)
    ?? await source.read("horas/Latin/Psalterium/Psalmi/Psalmi minor.txt");
  if (text === null) return null;

  const index =
    selection && version ? planIndex(hour, weekday, selection, version) : 2 * weekday;
  const plan = parsePlan(text, hour, index);
  if (!plan || plan.psalms.length === 0) return null;
  // A Sunday Prime that falls in Paschaltide or on a feast uses psalm 53 where
  // the psalter prints 117.
  // A day can borrow its office from another file (`ex Sancti/12-25`), and the
  // "Laudes 2" that switches psalm 117 for 53 lives in *that* file's rule as
  // often as in this one's.
  const borrowedRule = selection ? await borrowedFileRule(source, lang, selection, context) : "";
  if (
    version &&
    /196/.test(version) &&
    /117/.test(plan.psalms.map((spec) => spec.number).join(",")) &&
    ((selection?.laudes ?? 0) === 2 || /Laudes 2|Prima=53/i.test(rule) || /Laudes 2|Prima=53/i.test(borrowedRule))
  ) {
    plan.psalms = plan.psalms.map((spec) => (spec.number === 117 ? { ...spec, number: 53 } : spec));
  }

  const close = await doxology(source, lang, rule, context, render);
  const rows: OfficeLine[][] = [];

  // A feast that keeps the psalterium's psalms still brings its own antiphon:
  // the rule says `Antiphonas horas`, and the antiphon is `[Ant <hour>]` in the
  // day's file (or the file its rule redirects to with `ex`, or the commune).
  const dayAntiphon = selection
    ? await hourAntiphon(source, lang, hour, selection, context, render)
    : null;

  for (const [index, spec] of plan.psalms.entries()) {
    const lines: OfficeLine[] = [];
    if (index === 0) {
      const antiphon = renderLine(`Ant. ${dayAntiphon ?? plan.antiphon}`, render);
      if (antiphon) lines.push(antiphon);
    }
    // A psalm said in parts carries its range in the title: `Psalmus 21(2-12)`.
    const range =
      spec.from && spec.to
        ? `(${spec.from.verse}${spec.from.sub ?? ""}-${spec.to.verse}${spec.to.sub ?? ""})`
        : "";
    lines.push({ k: "title", text: `Psalmus ${spec.number}${range}`, after: `[${index + 1}]` });
    const verses = await psalmVerses(source, lang, spec, context);
    if (verses) lines.push(...renderBody(verses, render));
    lines.push(...close);
    rows.push(lines);
  }

  // The antiphon returns at the end of the last row, without its mediant.
  const last = rows[rows.length - 1];
  const repeated = (dayAntiphon ?? plan.antiphon).replace(/\s*\*\s*/, " ").trim();
  const antiphon = renderLine(`Ant. ${repeated}`, render);
  if (antiphon) {
    last.push(antiphon);
    // The engine prints the repetition as plain text, not as a rubric.
    last[last.length - 1] = { k: "rubric", marker: "Ant.", text: repeated };
  }
  void dayKey;
  return rows;
}

/** `[Ant <hour>]` from the day's own sources, when the rule asks for it. */
async function hourAntiphon(
  source: TextSource,
  lang: string,
  hour: string,
  selection: DaySelection,
  context: ConditionContext,
  render: RenderContext,
): Promise<string | null> {
  if (!/Antiphonas horas/i.test(selection.rule ?? "")) return null;

  const redirect = /^\s*(?:ex|vide)\s+([^;\n]+);?/im.exec(selection.rule ?? "");
  const candidates = [
    selection.winner,
    redirect ? `${redirect[1].trim()}.txt` : undefined,
    selection.commune || undefined,
  ].filter((path): path is string => typeof path === "string" && path !== "");

  for (const file of candidates) {
    const body = await resolveSection({
      name: `Ant ${hour}`,
      lang,
      source,
      context,
      dayFile: `horas/${lang}/${file}`,
    });
    if (body === null) continue;
    const lines = renderBody(body, render);
    const text = lines.map((line) => [line.marker, line.text].filter(Boolean).join(" ")).join(" ").trim();
    void context;
    if (text !== "") return text;
  }
  return null;
}

/** The `[Rule]` of the file a day's rule borrows its office from, if any. */
async function borrowedFileRule(
  source: TextSource,
  lang: string,
  selection: DaySelection,
  context: ConditionContext,
): Promise<string> {
  const redirect = /^\s*(?:ex|vide)\s+([^;\n]+);?/im.exec(selection.rule ?? "");
  if (!redirect) return "";
  const file = `${redirect[1].trim()}.txt`;
  for (const path of [`horas/${lang}/${file}`, `horas/Latin/${file}`]) {
    const text = await source.read(path);
    if (text === null) continue;
    const body = sectionBody(parseSections(text, context), "Rule");
    if (body) return body.join("\n");
  }
  return "";
}
