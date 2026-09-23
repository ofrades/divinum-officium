import type { ConditionContext } from "./conditional";
import { parseSections, sectionBody, type TextSource } from "./script";

// `Psalterium/Special/<Hour> Special.txt` holds what the hour adds of its own:
// the hymn (`[Hymnus Prima]`), and for the little hours the short reading and
// its blessing, keyed by season (`[Per Annum]`, `[Adv]`, `[Nat]`, …).

export function specialFileName(hour: string): string {
  return `${hour} Special.txt`;
}

/** A section of the hour's Special file, language first then Latin. */
export async function specialBody(
  source: TextSource,
  lang: string,
  hour: string,
  names: string[],
  context: ConditionContext,
  file?: string,
): Promise<string[] | null> {
  file = file ?? specialFileName(hour);
  for (const path of [`horas/${lang}/Psalterium/Special/${file}`, `horas/Latin/Psalterium/Special/${file}`]) {
    const text = await source.read(path);
    if (text === null) continue;
    const sections = parseSections(text, context);
    for (const name of names) {
      const body = sectionBody(sections, name);
      if (body !== null) return body;
    }
  }
  return null;
}
