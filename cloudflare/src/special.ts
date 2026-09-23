import type { ConditionContext } from "./conditional";
import { parseSections, sectionBody, type TextSource } from "./script";

// `Psalterium/Special/<Hour> Special.txt` holds what the hour adds of its own:
// the hymn (`[Hymnus Prima]`), and for the little hours the short reading and
// its blessing, keyed by season (`[Per Annum]`, `[Adv]`, `[Nat]`, …).

/**
 * The Special file that holds a hour's own material. They are kept per class,
 * not per hour: the small hours share `Minor Special.txt`, Lauds and Vespers
 * share `Major Special.txt`.
 */
export function specialFileName(hour: string): string {
  if (hour === "Prima") return "Prima Special.txt";
  if (/^(Tertia|Sexta|Nona|Completorium)$/.test(hour)) return "Minor Special.txt";
  if (/^(Laudes|Vesperae)$/.test(hour)) return "Major Special.txt";
  if (hour === "Matutinum") return "Matutinum Special.txt";
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
