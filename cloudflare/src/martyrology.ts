import type { ConditionContext } from "./conditional";
import { luna } from "./luna";
import { renderBody, type RenderContext } from "./render";
import { processConditionalLines } from "./conditional";
import type { TextSource } from "./script";
import { resolveSection } from "./texts";
import type { OfficeLine } from "./office";

// The martyrologium Prime announces: tomorrow's saints, read today.
//
// A port of `martyrologium()` in specials/specprima.pl: the *next* day's file
// out of the version's martyrology directory, its first line (the Kalends)
// given the moon's age and the year, every entry marked `r. ` for reading, and
// the closing versicles. The version chooses the directory — 1960 has its own
// — and a missing directory falls back to the ordinary one.

export interface MartyrologyReading {
  /** The reading itself, with the closing versicle. */
  lines: OfficeLine[];
  /** What follows in its own table row (the Pretiosa versicles). */
  tail: OfficeLine[];
}

function nextDay(date: string): { month: number; day: number; year: number } {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return { month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate(), year: parsed.getUTCFullYear() };
}

const padded = (value: number) => String(value).padStart(2, "0");

async function readFile(source: TextSource, lang: string, dir: string, name: string): Promise<string | null> {
  for (const path of [`horas/${lang}/${dir}/${name}`, `horas/Latin/${dir}/${name}`]) {
    const text = await source.read(path);
    if (text !== null) return text;
  }
  return null;
}

export async function martyrology(
  source: TextSource,
  lang: string,
  version: string,
  date: string,
  context: ConditionContext,
  render: RenderContext,
): Promise<MartyrologyReading | null> {
  const suffix = /1960|Newcal|2020/i.test(version) ? "1960" : "";
  const tomorrow = nextDay(date);
  const name = `${padded(tomorrow.month)}-${padded(tomorrow.day)}.txt`;

  const text =
    (suffix ? await readFile(source, lang, `Martyrologium${suffix}`, name) : null) ??
    (await readFile(source, lang, "Martyrologium", name));
  if (text === null) return null;

  const lines = processConditionalLines(text.split(/\r?\n/), context).map((line) => line.replace(/\s+$/, ""));
  if (lines.length === 0) return null;

  // The Kalends line carries the moon and the year.
  const moon = luna(tomorrow.month, tomorrow.day, tomorrow.year, lang);
  if (/Latin/i.test(lang) || /Latin$/i.test(lang)) {
    lines[0] = `${lines[0]} ${moon}`;
  } else {
    const portuguese = /^((?:Nas?|Nos?) .*(?:Calendas|Nonas|Idos) de \S+\.)$/;
    const english = /^Upon the \d+ ?.. day of \S+/i;
    let placed = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.trim() === "_") break;
      if (portuguese.test(line)) {
        lines[index] = line.replace(portuguese, `$1 ${moon}`);
        placed = true;
        break;
      }
      if (english.test(line)) {
        lines[index] = line.replace(english, `${moon} `);
        placed = true;
        break;
      }
    }
    if (!placed) lines.unshift(moon, "_");
  }

  // Entries are read aloud; the engine marks them and voices the first line.
  const marked = lines.map((line, index) => {
    const body = line.length > 4 && !line.startsWith("/:") ? `r. ${line}` : line;
    return index === 0 ? body.replace(/^r/, "v") : body;
  });

  const reading: OfficeLine[] = [
    ...renderBody(marked.filter((line) => line.trim() !== "_"), render),
    ...((await resolveSection({ name: "Conclmart", lang, source, context })) ?? []).flatMap((line) =>
      renderBody([line], render),
    ),
  ];

  // The Pretiosa versicles print in their own row on the page.
  const pretiosa = await resolveSection({ name: "Pretiosa", lang, source, context });
  const tail: OfficeLine[] = pretiosa ? renderBody(pretiosa, render) : [];

  return { lines: reading, tail };
}
