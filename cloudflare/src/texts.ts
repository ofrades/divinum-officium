import type { ConditionContext } from "./conditional";
import { parseSections, sectionBody, type TextSource } from "./script";

// Where a reference resolves. The engine looks an item up in the day's own
// file first, then in the shared tables a language keeps under
// `Psalterium/Common/`, falling back to Latin when a language has no entry of
// its own — the same order `setupstring`/`prayer` use.

export interface LookupRequest {
  name: string;
  lang: string;
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

/** The body of `[name]`, resolved through the language's tables. */
export async function resolveSection(request: LookupRequest): Promise<string[] | null> {
  const paths = [
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
      if (body !== null) return body;
    }
  }
  return null;
}
