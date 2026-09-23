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

/**
 * The season key the Special files use (`[Per Annum]`, `[Adv]`, `[Nat]`, …),
 * which is not the same wording as the liturgical season: ordinary time is
 * "Per Annum" there, and the Pentecost octave has its own section.
 */
export function specialSeasonKey(dayKey: string): string {
  if (/^Adv/.test(dayKey)) return "Adv";
  if (/^Nat/.test(dayKey)) return "Nat";
  if (/^Epi/.test(dayKey)) return "Epi";
  if (/^Asc/.test(dayKey)) return "Asc";
  if (/^Quadp/.test(dayKey)) return "Quad";
  if (/^Quad5/.test(dayKey)) return "Quad5";
  if (/^Quad/.test(dayKey)) return "Quad";
  if (/^Pasc/.test(dayKey)) return "Pasch";
  if (/^Pent/.test(dayKey)) return "Per Annum";
  return "Per Annum";
}
