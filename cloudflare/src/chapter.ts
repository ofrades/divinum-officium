import type { ConditionContext } from "./conditional";
import { renderBody, type RenderContext } from "./render";
import { specialBody, specialFileName } from "./special";
import { resolveSection } from "./texts";
import type { OfficeLine } from "./office";
import type { TextSource } from "./script";

// The little hours' chapter, responsory and versicle.
//
// `capitulum_prima` in the engine picks between the Special file's `[Feria]`
// and `[Dominica]` sections; under the 1960 rubrics the guard `$version !~
// /196[03]/` is false, so it is always `[Dominica]` — which is why Prime's
// chapter is the same every day of the year in the corpus. The responsory and
// versicle follow from the same file.

const SEASON_SUFFIX = ["Adv", "Nat", "Epi", "Asc", "Quad5", "Quad", "Pasch", "Pent", "Corp", "Heart"];

export async function littleChapter(
  source: TextSource,
  lang: string,
  hour: string,
  context: ConditionContext,
  render: RenderContext,
  season: string,
  weekday: number,
): Promise<OfficeLine[] | null> {
  if (!/^(Prima|Tertia|Sexta|Nona)$/.test(hour)) return null;

  const lines: OfficeLine[] = [];

  // The chapter itself. Terce, Sext and None keep theirs in the shared
  // `Minor Special.txt`, keyed by day class and hour; Prime keeps its own (and
  // under the 1960 rubrics always takes `[Dominica]`).
  const dayClass = weekday === 0 ? "Dominica" : "Feria";
  const chapterFile = specialFileName(hour);
  const chapterNames =
    hour === "Prima"
      ? ["Dominica"]
      : [`${dayClass} ${hour}`, `${season} ${hour}`, `Dominica ${hour}`, `Feria ${hour}`];
  const chapter = await specialBody(source, lang, hour, chapterNames, context, chapterFile);
  if (chapter === null) return null;
  const minorChapter = chapter;
  lines.push(...renderBody(chapter, render));
  const thanks = await resolveSection({ name: "Deo gratias", lang, source, context });
  if (thanks) lines.push(...renderBody(thanks, render));

  // The responsory: the shared one at Prime, the hour's own breve otherwise.
  const responsoryNames =
    hour === "Prima"
      ? ["Responsory", ...SEASON_SUFFIX.map((suffix) => `Responsory ${suffix}`)]
      : [`Responsory breve ${dayClass} ${hour}`, `Responsory breve ${season} ${hour}`, "Responsory"];
  const responsory = await specialBody(source, lang, hour, responsoryNames, context, chapterFile);
  if (responsory) {
    const body = await expandReferences(responsory, source, lang, context);
    lines.push(...renderBody(body, render));
  }

  // The versicle.
  const versum = await specialBody(source, lang, hour, ["Versum", `Versum ${hour}`], context, chapterFile);
  if (versum) lines.push(...renderBody(versum, render));

  return lines;
}

/** Resolve the references a body leans on (`&Gloria1`, `$Deo gratias`). */
async function expandReferences(
  body: string[],
  source: TextSource,
  lang: string,
  context: ConditionContext,
): Promise<string[]> {
  const out: string[] = [];
  for (const line of body) {
    const reference = /^[$&]\s*(.+)$/.exec(line.trim());
    if (!reference) {
      out.push(line);
      continue;
    }
    const resolved = await resolveSection({ name: reference[1].trim(), lang, source, context });
    if (resolved) out.push(...resolved);
    else out.push(line);
  }
  return out;
}

/**
 * The Oratio of a little hour. Its Ordinarium block is empty because the engine
 * generates it: the versicles, `Orémus.`, then the day's own collect — taken
 * from the winning file — and `Per Dóminum`.
 */
export async function minorOratio(
  source: TextSource,
  lang: string,
  request: { winner: string },
  context: ConditionContext,
  render: RenderContext,
): Promise<OfficeLine[] | null> {
  const dayFile = request.winner === "" ? undefined : `horas/${lang}/${request.winner}`;
  const [versicles, oremus, collect, perDominum] = await Promise.all([
    resolveSection({ name: "Dominus", lang, source, context }),
    resolveSection({ name: "Oremus", lang, source, context }),
    resolveSection({ name: "Oratio", lang, source, context, dayFile }),
    resolveSection({ name: "Per Dominum", lang, source, context }),
  ]);
  if (collect === null) return null;
  return renderBody(
    [...(versicles ?? []).slice(2, 4), ...(oremus ?? []), ...collect, ...(perDominum ?? [])],
    render,
  );
}
