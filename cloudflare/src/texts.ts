import type { ConditionContext } from "./conditional";
import { parseSections, sectionBody, type TextSource } from "./script";

// Where a reference resolves. The engine looks an item up in the day's own
// file first, then in the shared tables a language keeps under
// `Psalterium/Common/`, falling back to Latin when a language has no entry of
// its own — the same order `setupstring`/`prayer` use.

export interface LookupRequest {
  name: string;
  lang: string;
  /** A specific data file to read, when a directive names one. */
  file?: string;
  /** The day's own file, relative to web/www (e.g. `horas/Latin/Tempora/Pent17-3.txt`). */
  dayFile?: string;
  source: TextSource;
  context: ConditionContext;
}

/**
 * Reference names are spelled inconsistently in the scripts — Lauds writes
 * `$Deus_in_adjutorium` where Prime writes `$Deus in adjutorium` — and the
 * engine normalises them (`get_link_name`). Underscores stand in for spaces
 * here, which is what the scripts actually do.
 */
export function normaliseName(name: string): string[] {
  const cleaned = name.trim();
  const spaced = cleaned.replace(/_/g, " ");
  return spaced === cleaned ? [cleaned] : [cleaned, spaced];
}

/**
 * Script functions: references the engine answers with code rather than a
 * section lookup (`horasscripts.pl`'s `: ScriptFunc` subs). Each takes the
 * prayer tables and returns the lines to print. Ported one at a time, as the
 * hours being assembled need them.
 */
type ScriptFunction = (lookup: LookupRequest) => Promise<string[] | null>;

async function prayerBody(request: LookupRequest, name: string): Promise<string[] | null> {
  return resolveSection({ ...request, name });
}

const SCRIPT_FUNCTIONS: Record<string, ScriptFunction> = {
  // horasscripts.pl: `Dominus_vobiscum` — for a reader (not a priest) this is
  // the "Dómine, exáudi oratiónem meam / Et clamor meus ad te véniat" pair,
  // which is lines 3-4 of `[Dominus]`.
  dominus_vobiscum: async (request) => {
    const body = await prayerBody(request, "Dominus");
    return body === null ? null : body.slice(2, 4);
  },
  // `Dominus_vobiscum1` is the same text with an extra preces flag the reader
  // does not carry yet.
  dominus_vobiscum1: async (request) => SCRIPT_FUNCTIONS.dominus_vobiscum(request),
  // `mLitany` returns the Kyrie and the silent Pater for the ferial preces; at
  // Prime those preces are not said, so it contributes nothing.
  mlitany: async () => [],
};

// `@` directives: a section may not hold text but an *inclusion* of another
// section, optionally narrowed to a line range and rewritten (`@:Name:1-2
// s/\+ //`). The engine's InclusionRegex and do_inclusion_substitutions.
const INCLUSION = /^\s*@([^\n:]+)?(?::([^\n:]+?))?[^\S\n\r]*(?::(.*))?$/;

export interface Inclusion {
  file?: string;
  section?: string;
  substitutions?: string;
}

export function parseInclusion(line: string): Inclusion | null {
  const match = INCLUSION.exec(line);
  if (!match) return null;
  return { file: match[1]?.trim(), section: match[2]?.trim(), substitutions: match[3]?.trim() };
}

/** `1-2` selects lines (1-based); `!1-2` deletes them; `s/…/…/flags` rewrites. */
export function applySubstitutions(lines: string[], substitutions: string): string[] {
  let out = [...lines];
  // Named groups: the two alternatives have different shapes, and counting
  // positional groups across an alternation is how this was wrong at first.
  const pattern =
    /s\/(?<pattern>[^/]*)\/(?<replacement>[^/]*)\/(?<flags>[gims]*)|(?<delete>!?)(?<start>\d+)(?:-(?<end>\d+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(substitutions)) !== null) {
    const groups = match.groups ?? {};
    if (groups.start) {
      const start = parseInt(groups.start, 10) - 1;
      const end = groups.end ? parseInt(groups.end, 10) : start + 1;
      const slice = out.slice(start, end);
      // A leading `!` deletes the range instead of selecting it.
      out = groups.delete ? out.filter((_, index) => index < start || index >= end) : slice;
      continue;
    }
    if (groups.pattern !== undefined) {
      const flags = (groups.flags ?? "").includes("g") ? "g" : "";
      const expression = new RegExp(groups.pattern, flags + ((groups.flags ?? "").includes("i") ? "i" : ""));
      out = out.map((line) => line.replace(expression, groups.replacement ?? ""));
    }
  }
  return out;
}


/**
 * Resolve `@` inclusions line by line, as `setupstring` does: a body may be one
 * inclusion, three of them (`[Deus in adjutorium iij]`), or text with an
 * inclusion somewhere in the middle.
 */
async function resolveInclusions(body: string[], request: LookupRequest, depth = 0): Promise<string[]> {
  if (depth > 5) return body;
  const out: string[] = [];
  for (const line of body) {
    const inclusion = parseInclusion(line);
    if (!inclusion || !inclusion.section) {
      out.push(line);
      continue;
    }
    const inner = await resolveSection(
      { ...request, name: inclusion.section, file: inclusion.file ?? request.file },
      depth + 1,
    );
    if (inner === null) {
      out.push(line);
      continue;
    }
    out.push(...(inclusion.substitutions ? applySubstitutions(inner, inclusion.substitutions) : inner));
  }
  return out;
}

/** The body of `[name]`, resolved through the language's tables. */
export async function resolveSection(request: LookupRequest, depth = 0): Promise<string[] | null> {
  // Script functions answer first, as the engine does.
  const fn = SCRIPT_FUNCTIONS[request.name.trim().toLowerCase()];
  if (fn) return fn(request);

  const paths = [
    request.file ? filePath(request.lang, request.file) : undefined,
    request.dayFile,
    `horas/${request.lang}/Psalterium/Common/Prayers.txt`,
    "horas/Latin/Psalterium/Common/Prayers.txt",
  ].filter((path): path is string => typeof path === "string");

  for (const path of paths) {
    const text = await request.source.read(path);
    if (text === null) continue;
    const sections = parseSections(text, request.context);
    for (const name of normaliseName(request.name)) {
      const body = sectionBody(sections, name);
      if (body !== null) return resolveInclusions(body, request, depth);
    }
  }
  return null;
}

/** Where a directive's file name points, language first. */
function filePath(lang: string, file: string): string {
  const trimmed = file.trim();
  if (trimmed.startsWith("horas/")) return trimmed;
  return `horas/${lang}/${trimmed.endsWith(".txt") ? trimmed : `${trimmed}.txt`}`;
}
